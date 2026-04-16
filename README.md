# FunSync Player

A local desktop video player with device synchronization for funscript playback. Built with Electron and designed for Windows.

**[Download Latest Release](https://github.com/DaveMakesWaves/funsync-player/releases/latest)**

---

## Features

### Video Player
- Full-featured player with custom controls, keyboard shortcuts, and drag-and-drop
- Subtitle support (.srt, .vtt)
- Screenshot capture, picture-in-picture, aspect ratio cycling
- A-B loop points for repeat sections

### Library
- Browse and organize your video collection from a local directory
- Thumbnail grid with lazy loading
- Funscript auto-pairing by filename
- Search, sort by name/duration/speed, filter matched/unmatched
- Playlists and categories with color-coded badges
- Multi-select for bulk playlist/category assignment

### Funscript Support
- Heatmap overlay on the seek bar (speed-colored)
- Hover thumbnail preview on the seek bar
- Manual funscript association with fuzzy-ranked suggestions
- Speed stats (average/max) displayed on library cards

### Device Integration
- **The Handy** — HSSP cloud sync with automatic script upload, drift detection, and re-sync
- **Buttplug.io** — Connect to 700+ devices via Intiface Central (strokers, vibrators, rotators)
- Device simulator overlay showing real-time stroke position
- Works without any device connected — pure video playback is fully functional

### Script Editor (Experimental)
- OFS-style action graph with centered playhead and speed-colored lines
- Click to insert actions, numpad placement (0-9 maps to position 0-100)
- Frame-by-frame stepping, selection, copy/paste, undo/redo
- Modifier tools: half/double speed, remap range, offset time, remove pauses, reverse
- Pattern generator: sine, sawtooth, square, triangle, escalating, random
- Gap detection and fill with configurable patterns
- Audio waveform display and beat detection for music-synced scripting
- Metadata editor (title, creator, tags, performers)
- Bookmarks with named markers on the graph
- Autosave with automatic Handy re-upload

### Multi-Axis Support (Experimental)
- TCode convention detection (10 standard axes)
- Companion file detection by filename suffix
- Axis-to-device feature mapping

### Data
- Settings, playlists, and categories stored locally (no cloud, no account)
- Export/import backups as .funsync-backup zip files
- Automatic updates — get notified when a new version is available

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
| Space / K | Play / Pause |
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
| Escape | Clear loop |
| R | Cycle aspect ratio |
| E | Toggle script editor |
| D | Toggle device simulator |

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
