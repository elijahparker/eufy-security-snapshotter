require('dotenv').config();
const EufySecuritySnapshotter = require('./index');
const fs = require('fs');
const path = require('path');

async function runDemo() {
    console.log("--------------------------------------------------");
    console.log("Eufy Security Snapshotter Demo Utility");
    console.log("--------------------------------------------------");

    const snapshotsDir = './snapshots';
    if (!fs.existsSync(snapshotsDir)) {
        fs.mkdirSync(snapshotsDir, { recursive: true });
    }

    // Create a new instance
    const snapshotter = new EufySecuritySnapshotter({
        username: process.env.EUFY_USERNAME,
        password: process.env.EUFY_PASSWORD,
        deviceSerial: process.env.DEVICE_SERIAL || process.env.EUFY_CAMERA_SERIAL,
        presetIndex: process.env.PRESET_INDEX || 0,
        tokenPath: './persistent.json'
    });

    try {
        // Step 1: Initialize session
        console.log("Initializing session...");
        await snapshotter.initialize();
        console.log("Session successfully initialized!\n");

        // Step 2: Check for specific options
        const onlySnapshot = process.argv.includes('--only-snapshot');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        if (onlySnapshot) {
            console.log("Running standard snapshot capture (returning Buffer)...");
            const imageBuffer = await snapshotter.takeSnapshot();
            
            const imagePath = path.join(snapshotsDir, `snapshot_${timestamp}.jpg`);
            fs.writeFileSync(imagePath, imageBuffer);
            console.log(`\nDemo completed successfully!`);
            console.log(`Saved Image to Disk: ${imagePath}`);
        } else {
            console.log("Running snapshot capture + local weather inference (returning Buffer + Metadata)...");
            const { imageBuffer, metadata } = await snapshotter.takeSnapshotWithWeather();
            
            // Generate file paths and write both files to disk in the demo
            const imagePath = path.join(snapshotsDir, `snapshot_${timestamp}.jpg`);
            const metadataPath = path.join(snapshotsDir, `snapshot_${timestamp}.json`);
            
            fs.writeFileSync(imagePath, imageBuffer);
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

            console.log(`\nDemo completed successfully!`);
            console.log(`Saved Image to Disk: ${imagePath}`);
            console.log(`Saved Metadata to Disk: ${metadataPath}`);
            console.log(`Detected Weather: ${metadata.weather.label.toUpperCase()} (${(metadata.weather.confidence * 100).toFixed(2)}%)`);
        }

    } catch (err) {
        console.error("\nDemo execution failed:", err.message);
    } finally {
        // Step 3: Ensure session is cleanly closed
        console.log("\nClosing session...");
        await snapshotter.close();
        console.log("Shutdown complete.");
        process.exit(0);
    }
}

// Handle SIGINT and SIGTERM gracefully to ensure we call close()
process.on('SIGINT', async () => {
    console.log("\nInterrupted, shutting down cleanly...");
    process.exit(0);
});

runDemo();
