require('dotenv').config();
const EufySecuritySnapshotter = require('./index');

async function runDemo() {
    console.log("--------------------------------------------------");
    console.log("Eufy Security Snapshotter Demo Utility");
    console.log("--------------------------------------------------");

    // Create a new instance
    const snapshotter = new EufySecuritySnapshotter({
        username: process.env.EUFY_USERNAME,
        password: process.env.EUFY_PASSWORD,
        deviceSerial: process.env.DEVICE_SERIAL || process.env.EUFY_CAMERA_SERIAL,
        presetIndex: process.env.PRESET_INDEX || 0,
        snapshotsDir: './snapshots',
        tokenPath: './persistent.json'
    });

    try {
        // Step 1: Initialize session
        console.log("Initializing session...");
        await snapshotter.initialize();
        console.log("Session successfully initialized!\n");

        // Step 2: Check for specific options
        const onlySnapshot = process.argv.includes('--only-snapshot');

        if (onlySnapshot) {
            console.log("Running standard snapshot capture...");
            const imagePath = await snapshotter.takeSnapshot();
            console.log(`\nDemo completed successfully!`);
            console.log(`Saved Image: ${imagePath}`);
        } else {
            console.log("Running snapshot capture + local weather inference...");
            const result = await snapshotter.takeSnapshotWithWeather();
            console.log(`\nDemo completed successfully!`);
            console.log(`Saved Image: ${result.imagePath}`);
            console.log(`Saved Metadata: ${result.metadataPath}`);
            console.log(`Detected Weather: ${result.weather.label.toUpperCase()} (${(result.weather.confidence * 100).toFixed(2)}%)`);
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
