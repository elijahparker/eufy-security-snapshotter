# Eufy Security Snapshotter with Local Weather Classification

A modular Node.js SDK and utility for capturing snapshots from Eufy Pan/Tilt cameras (including fully custom support for the **eufyCam C31 / T817L**), rotating the camera to specific preset angles, and running **fully offline local AI image inference** using ONNX to classify weather conditions.

## Key Features
- **Object-Oriented SDK Design:** Exports a reusable, developer-friendly class that integrates seamlessly into larger applications.
- **Persistent Sessions:** Automatically saves authentication tokens locally to minimize 2FA prompt frequency.
- **Preset Position Control:** Moves Pan/Tilt cameras to specific preset indices before taking the capture.
- **Efficient Frame Capturing:** Establishes local P2P livestreaming, captures a single high-quality frame with FFmpeg, and instantly shuts down the stream. Falling back to Eufy Cloud image URLs if livestreaming is unsupported.
- **Local ONNX Weather Inference:** Runs a lightweight 5.9MB pre-trained 14-class ResNet50 model offline in under 650ms.
- **Re-normalized Prediction Filtering:** Restricts predictions to 6 core atmospheric weather classes (`cloudy`, `fogsmog`, `rain`, `shine` (sunny), `rainbow`, and `snow`), re-normalizing their relative confidence to 100% and discarding misleading classifications like lens condensation or dew.

---

## SDK API Reference

### Installation

```bash
npm install eufy-security-snapshotter
```

### Usage Example

```javascript
const EufySecuritySnapshotter = require('eufy-security-snapshotter');

async function main() {
    // 1. Instantiate the class with your credentials and config
    const snapshotter = new EufySecuritySnapshotter({
        username: "your-email@example.com",
        password: "your-password",
        deviceSerial: "T817LT002605061C", // Camera serial number
        presetIndex: 3,                   // Preset to rotate to (optional)
        snapshotsDir: "./custom_snapshots",// Where to save files (optional)
        tokenPath: "./persistent.json"    // Session cache (optional)
    });

    try {
        // 2. Initialize and connect to the Eufy Cloud & Local P2P
        console.log("Connecting...");
        await snapshotter.initialize();

        // 3. Option A: Capture a standard raw image snapshot
        const imagePath = await snapshotter.takeSnapshot();
        console.log(`Saved snapshot to: ${imagePath}`);

        // 4. Option B: Capture snapshot AND run local weather analysis
        const { imagePath, metadataPath, weather } = await snapshotter.takeSnapshotWithWeather();
        console.log(`Snapshot Path: ${imagePath}`);
        console.log(`Weather JSON Path: ${metadataPath}`);
        console.log(`Detected Weather: ${weather.label} (${(weather.confidence * 100).toFixed(2)}%)`);

    } catch (error) {
        console.error("Snapshot failed:", error.message);
    } finally {
        // 5. Cleanly close the session
        await snapshotter.close();
    }
}

main();
```

---

## Demo Utility

This repository includes a standalone demo utility (`demo.js`) allowing you to trigger on-demand snapshots and verify your setup.

### 1. Prerequisites
- **Node.js:** Latest LTS version.
- **FFmpeg:** Must be installed on your system path.
  - *Amazon Linux / RHEL / Fedora:*
    ```bash
    sudo dnf install ffmpeg-free -y
    ```
  - *Ubuntu / Debian:*
    ```bash
    sudo apt update && sudo apt install ffmpeg -y
    ```

### 2. Setup Configuration
1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/elijahparker/eufy-security-snapshotter.git
   cd eufy-security-snapshotter
   npm install
   ```

2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

3. Open `.env` and fill in your details:
   ```env
   EUFY_USERNAME="your-eufy-account-email@example.com"
   EUFY_PASSWORD="your-eufy-account-password"
   DEVICE_SERIAL="T817LT002605061C"
   PRESET_INDEX=3
   ```

### 3. Run the Demo

To capture a snapshot and run the **ONNX weather classification** (saves a `.jpg` and `.json` in `./snapshots`):
```bash
node demo.js
```

To run a **raw snapshot only** without loading the ONNX model or running classification:
```bash
node demo.js --only-snapshot
```

### 4. View Saved Weather Logs
A companion `.json` file is saved with each capture preserving the complete list of normalized class scores:
```bash
# Print the results of the newest snapshot weather analysis
cat $(ls -t snapshots/*.json | head -n 1)
```

Example JSON metadata output:
```json
{
  "timestamp": "2026-06-18T14:01:49.389Z",
  "camera": {
    "name": "Garage",
    "serial": "T817LT002605061C",
    "model": "T817L"
  },
  "weather": {
    "label": "cloudy",
    "confidence": 0.6898,
    "scores": {
      "cloudy": 0.6898,
      "rain": 0.2014,
      "fogsmog": 0.0542,
      "shine": 0.0315,
      "snow": 0.0182,
      "rainbow": 0.0049
    }
  }
}
```

---

## License
MIT License.
