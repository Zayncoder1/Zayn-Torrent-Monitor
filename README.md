# Zayn Torrent Monitor

Electron + WebTorrent desktop app to monitor and control torrents.

Features
- Add magnet links or .torrent files
- Pause/Resume (disconnects peers on pause)
- Network status detection
- Settings for torrent port (0 = auto), web UI (default off), bind IP, and port forwarding toggles
- Optional web UI (`/` and `/api/stats`) for remote checking

Getting Started
1. `npm install`
2. `npm start`

Build Installer (Windows)
1. `npm run build`
2. The NSIS `.exe` will be created in `dist/`

Notes
- Torrent port can be set to `0` to pick an unused port.
- Web UI is disabled by default; enable it in Settings when needed.

License
MIT