# Stream Lurker

A standalone desktop application (Electron) that monitors your favorite Twitch, Kick, YouTube, and Rumble streamers, auto-lurks live channels, and manages Twitch Drops & channel-point claiming — with adblock extension support.

## Features

- **Multi-platform live monitoring** — Twitch, Kick, YouTube, and Rumble.
- **Multi-lurk grid** — watch several streams at once in muted, low-quality webview containers.
- **Watch-priority queue** — streamers are watched in your configured priority order.
- **Stream schedule calendar** synced from each platform.
- **Adblock extension support** via loadable Chromium extensions.

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)

### Install & Run
```bash
npm install
npm start
```

### Build a distributable
```bash
npm run dist          # Windows installer
npm run dist-linux    # Linux AppImage / tar.gz
```

## Usage

1. Launch the app and open **Platform Logins** to sign in to Twitch (and any other platforms).
2. Add streamers to your watch list.
3. Open the **Drops & Inventory** tab to discover campaigns, quest for rewards, and track progress.

## Notes

- Your login sessions and settings are stored locally in Electron's user-data directory
  (`%APPDATA%/stream-lurker` on Windows). They are **not** part of this repository.
- This project uses Twitch's public web GraphQL API for read-only discovery and progress queries.

## License

MIT
