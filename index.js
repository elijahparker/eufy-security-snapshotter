require('dotenv').config();
const { EufySecurity, DeviceType, PropertyName, CommandName } = require('eufy-security-client');
const ffmpeg = require('fluent-ffmpeg');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { determineWeather } = require('./weather-inference');

// Configuration
const config = {
    username: process.env.EUFY_USERNAME,
    password: process.env.EUFY_PASSWORD,
    deviceSerial: process.env.DEVICE_SERIAL,
    presetIndex: parseInt(process.env.PRESET_INDEX || '0'),
    schedule: process.env.SNAPSHOT_SCHEDULE || '0 12 * * *',
    tokenPath: process.env.PERSISTENT_TOKEN_PATH || './persistent_token.json',
    snapshotsDir: './snapshots'
};

if (!fs.existsSync('.env')) {
    console.error('[ERROR] .env file not found. Please copy .env.example to .env and fill in your credentials.');
    process.exit(1);
}

if (!fs.existsSync(config.snapshotsDir)) {
    fs.mkdirSync(config.snapshotsDir);
}

// Logger helper
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

async function main() {
    log('Starting Eufy Daily Snapshotter...');

    const eufy = await EufySecurity.initialize({
        username: config.username,
        password: config.password,
        language: 'en',
        persistentDir: path.dirname(config.tokenPath), // use persistentDir instead of persistentTokenPath usually
    });

    eufy.on('tfa_request', () => {
        log('2FA Code Required! Please check your email/app and enter it in the console.');
        process.stdin.once('data', (data) => {
            const code = data.toString().trim();
            eufy.connectWithCode(code);
        });
    });

    eufy.on('connect', async () => {
        log('Connected to Eufy Cloud.');
        
        // Wait for devices to be loaded
        setTimeout(async () => {
            log('Devices loaded. Scheduling task...');
            
            cron.schedule(config.schedule, () => {
                log('Running scheduled snapshot task...');
                takeSnapshot(eufy);
            });

            if (process.argv.includes('--test')) {
                log('Test mode enabled. Running snapshot immediately...');
                await takeSnapshot(eufy);
                shutdown();
            }
        }, 5000);
    });

    eufy.on('error', (err) => {
        log(`Eufy Error: ${err.message}`);
    });

    try {
        await eufy.connect();
    } catch (err) {
        log(`Connection Failed: ${err.message}`);
    }

    // Graceful shutdown
    const shutdown = async () => {
        log('Shutting down...');
        await eufy.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function takeSnapshot(eufy, retryCount = 0) {
    const devices = await eufy.getDevices();
    const camera = devices.find(d => d.getSerial() === config.deviceSerial);

    if (!camera) {
        log(`Error: Camera with SN ${config.deviceSerial} not found.`);
        return;
    }

    try {
        const stationSN = camera.getStationSerial();
        const station = await eufy.getStation(stationSN);

        log(`Camera found: ${camera.getName()} (Type: ${camera.getDeviceType()}, SN: ${camera.getSerial()})`);
        log(`Supported commands: ${JSON.stringify(camera.getCommands())}`);

        log(`Attempting to move to preset ${config.presetIndex}...`);
        
        try {
            await station.presetPosition(camera, config.presetIndex);
            log('Waiting 5 seconds for stabilization...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (presetErr) {
            log(`Preset movement not supported or failed: ${presetErr.message}. Skipping...`);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.join(config.snapshotsDir, `snapshot_${timestamp}.jpg`);
        
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
                log('Standard picture properties empty, searching raw properties...');
                pictureUrl = findImageUrl(camera.getProperties());
            }

            if (pictureUrl && typeof pictureUrl === 'string') {
                log(`Downloading fallback picture from: ${pictureUrl}`);
                await downloadImage(pictureUrl, filename);
                log(`Snapshot saved via fallback: ${filename}`);
            } else {
                throw new Error('This specific Eufy camera model does not support local P2P livestreaming via the API, and no recent event image URL is available in the Eufy Cloud to use as a fallback. Please ensure the camera is triggered recently or use a supported Pan/Tilt or Indoor model.');
            }
        };

        if (camera.hasCommand(CommandName.DeviceStartLivestream)) {
            log('Starting livestream...');
            let frameCaptured = false;

            const onLivestreamStart = (station, device, metadata, videostream) => {
                if (device.getSerial() !== camera.getSerial()) return;

                log('Livestream started. Capturing frame with FFmpeg...');
                ffmpeg(videostream)
                    .inputFormat('h264')
                    .outputOptions([
                        '-frames:v 1',
                        '-q:v 2'
                    ])
                    .on('end', () => {
                        log(`Snapshot saved: ${filename}`);
                        frameCaptured = true;
                        stopStream(eufy, camera);
                        eufy.removeListener('station livestream start', onLivestreamStart);
                    })
                    .on('error', (err) => {
                        log(`FFmpeg Error: ${err.message}`);
                        stopStream(eufy, camera);
                        eufy.removeListener('station livestream start', onLivestreamStart);
                    })
                    .save(filename);
            };

            eufy.on('station livestream start', onLivestreamStart);

            try {
                await eufy.startStationLivestream(camera.getSerial());

                // Safety timeout to stop livestream if ffmpeg fails to finish within 20s
                await new Promise(resolve => setTimeout(resolve, 20000));
                
                if (!frameCaptured) {
                    log('Capture timeout: Stopping livestream.');
                    stopStream(eufy, camera);
                    eufy.removeListener('station livestream start', onLivestreamStart);
                    throw new Error('Livestream capture timed out.');
                }
            } catch (err) {
                log(`Livestream failed: ${err.message}. Trying image fallback...`);
                await tryFallback();
            }
        } else {
            log('Livestream command not supported by this device. Using image fallback...');
            await tryFallback();
        }

        // Run local ONNX weather inference
        try {
            log('Analyzing weather on captured image...');
            const weather = await determineWeather(filename);
            log(`Weather classification: ${weather.label.toUpperCase()} (${(weather.confidence * 100).toFixed(2)}% confidence)`);
            
            const metadataPath = filename.replace('.jpg', '.json');
            const metadata = {
                timestamp: new Date().toISOString(),
                camera: {
                    name: camera.getName(),
                    serial: camera.getSerial(),
                    model: camera.getModel()
                },
                weather: {
                    label: weather.label,
                    confidence: weather.confidence,
                    scores: weather.scores
                }
            };
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            log(`Weather metadata saved to: ${metadataPath}`);
        } catch (weatherErr) {
            log(`Weather analysis failed: ${weatherErr.message}`);
        }

    } catch (err) {
        log(`Task Attempt ${retryCount + 1} Failed: ${err.message}`);
        if (camera) await stopStream(eufy, camera);

        if (retryCount < 1) {
            log('Retrying in 10 seconds...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            return takeSnapshot(eufy, retryCount + 1);
        } else {
            log('Max retries reached. Snapshot failed.');
        }
    }
}

async function stopStream(eufy, camera) {
    try {
        if (camera.hasCommand(CommandName.DeviceStopLivestream)) {
            log('Stopping livestream...');
            await eufy.stopStationLivestream(camera.getSerial());
        }
    } catch (err) {
        log(`Error stopping stream: ${err.message}`);
    }
}

main();
