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
     * @param {string} [config.snapshotsDir='./snapshots'] - Directory to save snapshot JPEGs and JSON metadata
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
            snapshotsDir: config.snapshotsDir || './snapshots',
            tokenPath: config.tokenPath || './persistent.json',
        };
        this.eufy = null;
        
        // Ensure snapshots directory exists
        if (!fs.existsSync(this.config.snapshotsDir)) {
            fs.mkdirSync(this.config.snapshotsDir, { recursive: true });
        }
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
     * Rotates camera to preset, captures snapshot from H.264 stream (falls back to Eufy Cloud image if stream fails).
     * @returns {Promise<string>} Path to the saved JPG.
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

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.join(this.config.snapshotsDir, `snapshot_${timestamp}.jpg`);

        const downloadImage = (url, dest) => {
            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(dest);
                https.get(url, (response) => {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close(resolve);
                    });
                }).on('error', (err) => {
                    fs.unlink(dest, () => {});
                    reject(err);
                });
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

        const tryFallback = async () => {
            let pictureUrl = camera.getPropertyValue('hidden-pictureUrl') || camera.getPropertyValue('picture');
            if (pictureUrl && pictureUrl.value) pictureUrl = pictureUrl.value;
            
            if (!pictureUrl || typeof pictureUrl !== 'string') {
                console.log(`[${new Date().toISOString()}] Standard picture properties empty, searching raw properties...`);
                pictureUrl = findImageUrl(camera.getProperties());
            }

            if (pictureUrl && typeof pictureUrl === 'string') {
                console.log(`[${new Date().toISOString()}] Downloading fallback picture from: ${pictureUrl}`);
                await downloadImage(pictureUrl, filename);
                console.log(`[${new Date().toISOString()}] Snapshot saved via fallback: ${filename}`);
            } else {
                throw new Error('This specific Eufy camera model does not support local P2P livestreaming via the API, and no recent event image URL is available in the Eufy Cloud to use as a fallback.');
            }
        };

        // Try streaming if supported
        if (camera.hasCommand(CommandName.DeviceStartLivestream)) {
            console.log(`[${new Date().toISOString()}] Starting livestream...`);
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
                ffmpeg(videostream)
                    .inputFormat('h264')
                    .outputOptions([
                        '-frames:v 1',
                        '-q:v 2'
                    ])
                    .on('end', () => {
                        console.log(`[${new Date().toISOString()}] Snapshot saved: ${filename}`);
                        frameCaptured = true;
                        stopStream();
                        this.eufy.removeListener('station livestream start', onLivestreamStart);
                    })
                    .on('error', (err) => {
                        console.error(`[${new Date().toISOString()}] FFmpeg Error: ${err.message}`);
                        stopStream();
                        this.eufy.removeListener('station livestream start', onLivestreamStart);
                    })
                    .save(filename);
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
                await tryFallback();
            }
        } else {
            console.log(`[${new Date().toISOString()}] Livestream command not supported by this device. Using image fallback...`);
            await tryFallback();
        }

        return filename;
    }

    /**
     * Rotates camera, captures snapshot, runs local weather inference, and saves companion metadata log.
     * @returns {Promise<{ imagePath: string, metadataPath: string, weather: Object }>}
     */
    async takeSnapshotWithWeather() {
        const imagePath = await this.takeSnapshot();
        
        console.log(`[${new Date().toISOString()}] Analyzing weather on captured image...`);
        const weather = await determineWeather(imagePath);
        console.log(`[${new Date().toISOString()}] Weather classification: ${weather.label.toUpperCase()} (${(weather.confidence * 100).toFixed(2)}% confidence)`);
        
        const metadataPath = imagePath.replace('.jpg', '.json');
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

        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        console.log(`[${new Date().toISOString()}] Weather metadata saved to: ${metadataPath}`);

        return {
            imagePath,
            metadataPath,
            weather
        };
    }
}

module.exports = EufySecuritySnapshotter;
