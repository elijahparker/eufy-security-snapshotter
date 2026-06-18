# Eufy Daily Snapshotter with Local Weather Classification

An automated Node.js application that schedules daily snapshots from a Eufy Pan/Tilt camera, moves the camera to a preset angle, captures a high-quality frame, and performs **fully offline local AI image inference** using ONNX to classify the weather.

## Key Features
- **Persistent Sessions:** Saves authentication credentials locally to minimize 2FA prompts.
- **Preset Positioning:** Automatically moves the camera to a specific preset position before snapshotting.
- **Stabilization Delay:** Delays capturing for 5 seconds to let the camera adjust its exposure and finish moving.
- **Local ONNX Weather Inference:** Runs a lightweight 5.9MB pre-trained 14-class ResNet50 model offline in under 650ms.
- **Smart Weather Filtering:** Restricts classification and re-normalizes prediction confidence to atmospheric conditions only (`cloudy`, `fogsmog`, `rain`, `shine` (sunny), `rainbow`, and `snow`) while ignoring misleading lens condensation/dew.
- **Companion Metadata Logs:** Saves a companion `.json` file for every snapshot containing accurate timestamps, camera details, and sorted weather classification probability scores.
- **Scheduled Execution:** Operates continuously based on custom cron schedules.

## Architecture
- **Runtime:** Node.js
- **Libraries:**
  - `eufy-security-client`: Connects to Eufy Cloud and establishes local P2P livestreaming.
  - `fluent-ffmpeg`: Captures high-quality frames directly from the live H.264 stream.
  - `onnxruntime-node`: Performs fast, zero-dependency local weather inference.
  - `jimp`: Preprocesses JPEG pixels into the BGR format tensor expected by the neural network.
  - `node-cron`: Manages continuous scheduling.
  - `dotenv`: Handles local environment variables.

## Prerequisites
- **Node.js:** Latest LTS recommended.
- **FFmpeg:** Must be installed on your system path.
  - **Amazon Linux / Fedora:**
    ```bash
    sudo dnf install ffmpeg-free -y
    ```
  - **Ubuntu / Debian:**
    ```bash
    sudo apt update && sudo apt install ffmpeg -y
    ```

## Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/elijahparker/eufy-daily-snapshotter.git
   cd eufy-daily-snapshotter
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy the example environment file and fill in your details:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to configure your:
   - Eufy Account credentials (username, password)
   - Camera Serial Number (`DEVICE_SERIAL`)
   - Target Preset position (`PRESET_INDEX`)
   - Snapshot Schedule cron expression (`SNAPSHOT_SCHEDULE`)

## Usage

### Run a Test Capture Immediately
To verify the connection, preset rotation, stream capturing, and weather classification on-demand:
```bash
node index.js --test
```

### Start the Daily Scheduler
To keep the application running continuously in the background on your schedule:
```bash
node index.js
```

### View Saved Snapshots & Weather Data
- **Snapshots** are saved under the `./snapshots` folder.
- **Weather scores** are saved under matching `.json` files:
  ```bash
  # View the most recent weather prediction details
  cat $(ls -t snapshots/*.json | head -n 1)
  ```

## License
MIT License.
