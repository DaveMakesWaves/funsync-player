# FunSync Player

A local desktop video player with device synchronization for funscript playback. Built with Electron and designed for Windows.

**[Download Latest Release](https://github.com/DaveMakesWaves/funsync-player/releases/latest)**

---

## Features

### Video Player
- Full-featured player with custom controls, keyboard shortcuts, and drag-and-drop
- Seek bar thumbnail preview (live frame capture on hover)
- Subtitle support (.srt, .vtt) with automatic SRT to WebVTT conversion
- Screenshot capture, picture-in-picture, aspect ratio cycling
- A-B loop points for repeat sections
- Replay button when video ends
- Script gap auto-skip with configurable countdown or skip button

### Library
- Browse and organize your video collection from a local directory
- Thumbnail grid with lazy loading and **live hover video preview**
- Grid and list view toggle
- Funscript auto-pairing by filename with auto/manual badges
- Subtitle auto-detection with auto/manual badges
- Search, sort by name/duration/speed, filter matched/unmatched tabs
- Playlists and categories with color-coded badges
- Multi-select for bulk playlist/category assignment
- Script variant detection — auto-detects multiple funscript versions per video

### EroScripts Integration
- Search and download community funscripts from within the app
- Login with 2FA support (authenticator app), persistent session
- Thumbnails and metadata in search results
- One-click download — scripts auto-renamed and paired with the current video
- Auto-match on video load — if no script is found locally, silently searches EroScripts and notifies

### Funscript Support
- Heatmap overlay on the seek bar (speed-colored)
- Gap indicators on the seek bar showing idle sections
- Manual funscript association with fuzzy-ranked suggestions
- Script variations — switch between multiple script versions during playback (V key)
- Multi-axis funscript support (TCode convention, 10 axes)
- Speed stats (average/max) displayed on library cards

### Script Smoothing
- PCHIP interpolation (shape-preserving, no overshoot) for smoother device motion
- Makima interpolation (less aggressive, good for oscillatory patterns)
- Configurable speed limit to prevent impossible device moves
- Per-setting persistence — configure once, applies to all playback

### Device Integration
- **The Handy** — HSSP cloud sync with automatic script upload, drift detection, and re-sync
- **Buttplug.io** — Connect to 700+ devices via Intiface Central (strokers, vibrators, rotators)
- **Auto-connect on startup** — both Handy and Buttplug.io connect automatically if previously configured
- Multi-axis routing — dedicated vibration scripts routed to Buttplug.io vibrate devices
- Device simulator overlay showing real-time stroke position
- Works without any device connected — pure video playback is fully functional

### Script Editor (Experimental)
- OFS-style action graph with centered playhead and speed-colored lines
- Numpad placement (0-9 maps to position 0-100), frame-by-frame stepping
- Selection, copy/paste, undo/redo
- Modifier tools: half/double speed, remap range, offset time, remove pauses, reverse
- Pattern generator: sine, sawtooth, square, triangle, escalating, random
- Gap detection and fill with configurable patterns
- Audio waveform display and beat detection for music-synced scripting
- Metadata editor (title, creator, tags, performers)
- Bookmarks with named markers on the graph
- Autosave toggle (off by default, shows save timestamp when enabled)

### Multi-Axis Support (Experimental)
- TCode convention detection (10 standard axes)
- Companion file detection by filename suffix
- Axis-to-device feature mapping
- Searchable dropdowns for axis assignment with fuzzy matching

### Data
- Settings, playlists, and categories stored locally (no cloud, no account)
- Export/import backups as .funsync-backup zip files
- Automatic updates — notified when a new version is available
- All user data preserved across updates

---

## Install

1. Download the latest `.exe` from the [Releases page](https://github.com/DaveMakesWaves/funsync-player/releases/latest)
2. Run the installer — no admin required, installs per-user
3. The app launches automatically after install

Updates are checked on startup. When a new version is available, a notification appears with a download button.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space / K | Play / Pause / Replay |
| Left / Right | Seek 5s |
| J / L | Seek 10s |
| Up / Down | Volume |
| M | Mute |
| F / F11 | Fullscreen |
| O | Open file |
| H | Device panel |
| S | Screenshot |
| I | Info overlay |
| A / B | Loop points |
| Escape | Clear loop / close panels |
| R | Cycle aspect ratio |
| E | Toggle script editor |
| D | Toggle device simulator |
| V / Shift+V | Cycle script variants |
| G / Shift+G | Skip to next/previous action |

---

## Requirements

- Windows 10/11 (x64)
- [Intiface Central](https://intiface.com/central/) for Buttplug.io device support (optional)

---

## Building from Source

```bash
npm install
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && cd ..
npm run build
```

Requires Node.js 18+, Python 3.11+, and ffmpeg/ffprobe binaries in the `ffmpeg/` directory.

---

## License

Private — not open for redistribution.
