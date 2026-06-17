# Eufy Daily Snapshotter

## Project Overview
A Node.js application that automates daily snapshots from a Eufy Pan/Tilt camera.

## Architecture
- **Runtime:** Node.js
- **Libraries:**
  - `eufy-security-client`: Interaction with Eufy Cloud and P2P communication.
  - `fluent-ffmpeg`: Processing livestream data to capture frames.
  - `node-cron`: Scheduling the daily snapshot task.
  - `dotenv`: Managing environment variables.

## Key Features
- **Persistent Sessions:** Saves authentication tokens to minimize 2FA prompts.
- **Preset Positioning:** Moves the camera to a specific preset before capturing.
- **Stabilization Delay:** Waits for the camera to finish moving and adjust exposure.
- **Efficient Capture:** Starts livestream, captures one frame via FFmpeg, and immediately stops the stream.
- **Scheduled Execution:** Runs daily based on a cron expression.

## Implementation Phases
1. **Setup:** Initialize project and install dependencies.
2. **Auth Logic:** Implement Eufy login with session persistence.
3. **Task Logic:** 
   - Connect to camera.
   - Move to preset.
   - Start stream.
   - Capture frame with FFmpeg.
   - Stop stream.
4. **Scheduling:** Wrap the task in a cron job.
5. **Error Handling:** P2P timeouts, 2FA requirements, and stream cleanup.

## Prerequisites
- **Node.js:** Latest LTS recommended.
- **FFmpeg:** Must be installed on the system.
  - **Amazon Linux 2023:**
    ```bash
    sudo dnf install ffmpeg-free -y
    ```
  - **Ubuntu/Debian:**
    ```bash
    sudo apt update && sudo apt install ffmpeg -y
    ```

## Usage
1. Copy `.env.example` to `.env`.
2. Fill in your Eufy credentials, camera serial number, and desired preset.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the application:
   ```bash
   node index.js
   ```
5. On the first run, if 2FA is enabled, check your email/app for the code and enter it in the console when prompted.
