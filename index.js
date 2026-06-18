const { EufySecurity, CommandName } = require('eufy-security-client');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { determineWeather } = require('./weather-inference');

class EufySecuritySnapshotter {
    /**
     * @param {Object} config
     * @param {string} config.username - Eufy account email
     * @param {string} config.password - Eufy account password
     * @param {string} config.deviceSerial - Camera serial number
     * @param {number|string} [config.presetIndex=0] - Preset index to rotate to
     * @param {string} [config.tokenPath='./persistent.json'] - Path to store session tokens
     */
    constructor(config) {
        if (!config || !config.username || !config.password || !config.deviceSerial) {
            throw new Error('EufySecuritySnapshotter requires username, password, and deviceSerial config options.');
        }

        this.config = {
            username: config.username,
            password: config.password,
            deviceSerial: config.deviceSerial,
            presetIndex: parseInt(config.presetIndex || '0'),
            tokenPath: config.tokenPath || './persistent.json',
        };
        this.eufy = null;
    }

    /**
     * Connects and initializes the session. Handles 2FA automatically if prompted.
     * @returns {Promise<void>} Resolves when connection and device list are fully loaded.
     */
    async initialize() {
        this.eufy = await EufySecurity.initialize({
            username: this.config.username,
            password: this.config.password,
            language: 'en',
            persistentDir: path.dirname(this.config.tokenPath),
        });

        // 2FA Handler
        this.eufy.on('tfa_request', () => {
            console.log(`[${new Date().toISOString()}] 2FA Code Required! Please check your email/app and enter it in the console.`);
            process.stdin.once('data', (data) => {
                const code = data.toString().trim();
                this.eufy.connectWithCode(code);
            });
        });

        this.eufy.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] Eufy Error: ${err.message}`);
        });

        return new Promise((resolve, reject) => {
            this.eufy.on('connect', () => {
                console.log(`[${new Date().toISOString()}] Connected to Eufy Cloud.`);
                // Wait briefly for devices to load
                setTimeout(resolve, 3000);
            });

            this.eufy.connect().catch(reject);
        });
    }

    /**
     * Closes the active session cleanly.
     * @returns {Promise<void>}
     */
    async close() {
        if (this.eufy) {
            await this.eufy.close();
        }
    }

    /**
     * Rotates camera to preset, captures snapshot and returns it as a Buffer.
     * Falls back to Eufy Cloud image if stream fails.
     * @returns {Promise<Buffer>} The image data in a JPEG Buffer.
     */
    async takeSnapshot() {
        if (!this.eufy) {
            throw new Error('EufySecuritySnapshotter is not initialized. Please call initialize() first.');
        }

        const devices = await this.eufy.getDevices();
        const camera = devices.find(d => d.getSerial() === this.config.deviceSerial);

        if (!camera) {
            throw new Error(`Camera with SN ${this.config.deviceSerial} not found.`);
        }

        const stationSN = camera.getStationSerial();
        const station = await this.eufy.getStation(stationSN);

        console.log(`[${new Date().toISOString()}] Camera found: ${camera.getName()} (Type: ${camera.getDeviceType()}, SN: ${camera.getSerial()})`);

        // Move to preset if supported
        try {
            console.log(`[${new Date().toISOString()}] Attempting to move to preset ${this.config.presetIndex}...`);
            await station.presetPosition(camera, this.config.presetIndex);
            console.log(`[${new Date().toISOString()}] Waiting 5 seconds for stabilization...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (presetErr) {
            console.log(`[${new Date().toISOString()}] Preset movement not supported or failed: ${presetErr.message}. Skipping...`);
        }

        const downloadImageToBuffer = (url) => {
            return new Promise((resolve, reject) => {
                https.get(url, (response) => {
                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    response.on('end', () => {
                        resolve(Buffer.concat(chunks));
                    });
                }).on('error', reject);
            });
        };

        const findImageUrl = (obj) => {
            if (!obj) return null;
            if (typeof obj === 'string' && (obj.includes('.jpg') || obj.includes('.jpeg') || obj.includes('.png')) && obj.startsWith('http')) {
                return obj;
            }
            if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                    const result = findImageUrl(obj[key]);
                    if (result) return result;
                }
            }
            return null;
        };

        const tryFallbackToBuffer = async () => {
            let pictureUrl = camera.getPropertyValue('hidden-pictureUrl') || camera.getPropertyValue('picture');
            if (pictureUrl && pictureUrl.value) pictureUrl = pictureUrl.value;
            
            if (!pictureUrl || typeof pictureUrl !== 'string') {
                console.log(`[${new Date().toISOString()}] Standard picture properties empty, searching raw properties...`);
                pictureUrl = findImageUrl(camera.getProperties());
            }

            if (pictureUrl && typeof pictureUrl === 'string') {
                console.log(`[${new Date().toISOString()}] Downloading fallback picture from: ${pictureUrl}`);
                const buffer = await downloadImageToBuffer(pictureUrl);
                console.log(`[${new Date().toISOString()}] Snapshot buffer downloaded successfully via fallback.`);
                return buffer;
            } else {
                throw new Error('This specific Eufy camera model does not support local P2P livestreaming via the API, and no recent event image URL is available in the Eufy Cloud to use as a fallback.');
            }
        };

        // Try streaming if supported
        if (camera.hasCommand(CommandName.DeviceStartLivestream)) {
            console.log(`[${new Date().toISOString()}] Starting livestream...`);
            
            return new Promise(async (resolvePromise, rejectPromise) => {
                let frameCaptured = false;

                const stopStream = async () => {
                    try {
                        if (camera.hasCommand(CommandName.DeviceStopLivestream)) {
                            console.log(`[${new Date().toISOString()}] Stopping livestream...`);
                            await this.eufy.stopStationLivestream(camera.getSerial());
                        }
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] Error stopping stream: ${err.message}`);
                    }
                };

                const onLivestreamStart = (station, device, metadata, videostream) => {
                    if (device.getSerial() !== camera.getSerial()) return;

                    console.log(`[${new Date().toISOString()}] Livestream started. Capturing frame with FFmpeg...`);
                    
                    const passThrough = new (require('stream').PassThrough)();
                    const chunks = [];
                    passThrough.on('data', chunk => chunks.push(chunk));
                    passThrough.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        console.log(`[${new Date().toISOString()}] Snapshot buffer created successfully from stream.`);
                        frameCaptured = true;
                        stopStream();
                        this.eufy.removeListener('station livestream start', onLivestreamStart);
                        resolvePromise(buffer);
                    });

                    ffmpeg(videostream)
                        .inputFormat('h264')
                        .outputOptions([
                            '-frames:v 1',
                            '-q:v 2'
                        ])
                        .format('image2')
                        .on('error', (err) => {
                            console.error(`[${new Date().toISOString()}] FFmpeg Error: ${err.message}`);
                            stopStream();
                            this.eufy.removeListener('station livestream start', onLivestreamStart);
                            rejectPromise(err);
                        })
                        .pipe(passThrough);
                };

                this.eufy.on('station livestream start', onLivestreamStart);

                try {
                    await this.eufy.startStationLivestream(camera.getSerial());
                    // Safety timeout (20s)
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    
                    if (!frameCaptured) {
                        this.eufy.removeListener('station livestream start', onLivestreamStart);
                        await stopStream();
                        throw new Error('Livestream capture timed out.');
                    }
                } catch (err) {
                    console.log(`[${new Date().toISOString()}] Livestream failed: ${err.message}. Trying image fallback...`);
                    try {
                        const fallbackBuffer = await tryFallbackToBuffer();
                        resolvePromise(fallbackBuffer);
                    } catch (fallbackErr) {
                        rejectPromise(fallbackErr);
                    }
                }
            });
        } else {
            console.log(`[${new Date().toISOString()}] Livestream command not supported by this device. Using image fallback...`);
            return tryFallbackToBuffer();
        }
    }

    /**
     * Rotates camera, captures snapshot buffer, runs local weather inference, and returns buffer and metadata object.
     * @returns {Promise<{ imageBuffer: Buffer, metadata: Object }>}
     */
    async takeSnapshotWithWeather() {
        const imageBuffer = await this.takeSnapshot();
        
        console.log(`[${new Date().toISOString()}] Analyzing weather on captured image buffer...`);
        const weather = await determineWeather(imageBuffer);
        console.log(`[${new Date().toISOString()}] Weather classification: ${weather.label.toUpperCase()} (${(weather.confidence * 100).toFixed(2)}% confidence)`);
        
        const metadata = {
            timestamp: new Date().toISOString(),
            camera: {
                serial: this.config.deviceSerial
            },
            weather: {
                label: weather.label,
                confidence: weather.confidence,
                scores: weather.scores
            }
        };

        try {
            const devices = await this.eufy.getDevices();
            const camera = devices.find(d => d.getSerial() === this.config.deviceSerial);
            if (camera) {
                metadata.camera = {
                    name: camera.getName(),
                    serial: camera.getSerial(),
                    model: camera.getModel()
                };
            }
        } catch (e) {}

        return {
            imageBuffer,
            metadata
        };
    }
}

module.exports = EufySecuritySnapshotter;
