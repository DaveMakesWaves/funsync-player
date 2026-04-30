# FunSync Player

A local desktop video player with device synchronization for funscript playback. Built with Electron. Windows and Linux.

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
- Browse and organize your video collection from one or more source folders
- **Grid / list / folder-tree** view toggle with thumbnail cards and live hover preview
- Drag-to-reorder sources, per-source enable/disable, overlap detection, hot-plug drive detection
- Funscript auto-pairing by filename with auto/manual badges; subtitle auto-detection
- Fuzzy search with exact-title precedence, path + collection + category matching, diacritic folding
- Sort by name, duration, average speed, max speed (matched tab only)
- Playlists, categories, and collections with pin-folder-as-collection support
- Multi-select for bulk playlist/category assignment
- Script variant detection — auto-detects multiple funscript versions per video

### Remote access
- **Web Remote** — control FunSync from your phone on the same WiFi. Library, playback, device sync. Installable as a PWA from the phone's home screen.
- **VR content server** — Quest standalone support via HereSphere. Your library appears in the headset; PC-connected devices sync automatically.
- **PCVR companion bridge** — HereSphere on PC (SteamVR, Virtual Desktop) driven via its timestamp API; all devices follow.
- **Session status card** docks bottom-right when an external source is driving playback, with a 50-entry history viewer and a VR ↔ Web Remote last-wins mutex.

### EroScripts Integration
- Search and download community funscripts from within the app
- Login with 2FA support (authenticator app), persistent session
- Thumbnails and metadata in search results
- One-click download — scripts auto-renamed, auto-associated, and paired with the current video
- Auto-match on video load — if no script is found locally, silently searches EroScripts and notifies

### Funscript Support
- Heatmap overlay on the seek bar (speed-colored)
- Gap indicators on the seek bar showing idle sections
- Manual funscript association with fuzzy-ranked suggestions
- Script variations — switch between multiple script versions during playback (V key)
- Multi-axis funscript support (TCode convention, 10 axes)
- **Custom routing** — assign different scripts to different devices per video, stable across Intiface restarts (index-first matching with name auto-heal)
- Speed stats (average/max) displayed on library cards

### Script Smoothing
- PCHIP interpolation (shape-preserving, no overshoot) for smoother device motion
- Makima interpolation (less aggressive, good for oscillatory patterns)
- Configurable speed limit to prevent impossible device moves
- Per-setting persistence — configure once, applies to all playback

### Device Integration
- **The Handy** — HSSP cloud sync with automatic script upload, drift detection, 10-second cloud health check (catches BT-mode switches)
- **Buttplug.io** — Connect to 700+ devices via Intiface Central (strokers, vibrators, rotators, e-stim)
- **TCode serial (OSR2 / SR6)** — USB serial with per-axis enable + min/max controls for all 10 axes (experimental)
- **Autoblow Ultra / VacuGlide 2** — Cloud API (experimental)
- **Auto-connect on startup** — Handy and Buttplug.io connect automatically if previously configured
- Per-device offset controls + unified Sync tab showing total effective offset (VR + device stacking)
- Device simulator overlay showing real-time stroke position
- Works without any device connected — pure video playback is fully functional

### Script Editor (Experimental)
- OFS-style action graph with centered playhead and speed-colored lines
- Numpad placement (0-9 maps to position 0-100), frame-by-frame stepping, snap-to-frame toggle
- Selection, copy/paste, undo/redo (per-script history persistence)
- Multi-script selector for multi-axis / custom-routing editing
- Modifier tools: half/double speed, remap range, offset time, remove pauses, reverse
- Pattern generator: sine, sawtooth, square, triangle, escalating, random
- Gap detection and fill with configurable patterns
- Audio waveform display and beat detection for music-synced scripting
- Metadata editor (title, creator, tags, performers)
- Bookmarks with named markers on the graph
- Live device preview on numpad placement (when sync engine is idle)
- Autosave toggle (off by default, shows save timestamp when enabled)

### Multi-Axis Support (Experimental)
- TCode convention detection (10 standard axes)
- Companion file detection by filename suffix
- Axis-to-device feature mapping
- Searchable dropdowns for axis assignment with fuzzy matching

### Data
- Settings, playlists, and categories stored locally (no cloud, no account)
- Export/import backups as .funsync-backup zip files
- Automatic updates — notified when a new version is available; **you control download AND install** (no silent install on app quit)
- All user data preserved across updates

---

## Install

1. Download the latest installer from the [Releases page](https://github.com/DaveMakesWaves/funsync-player/releases/latest)
   - **Windows**: `FunSync Player Setup X.Y.Z.exe`
   - **Linux**: `FunSync-Player-X.Y.Z.AppImage`
2. Run the installer / AppImage
   - Windows: no admin required, installs per-user
   - Linux: `chmod +x` the AppImage, then run
3. The app launches automatically

Updates are checked on startup. When a new version is available, a toast appears — click Download, then Restart Now when ready.

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

### Script Editor (when canvas focused)

| Key / Mouse | Action |
|-------------|--------|
| 0-9 / Numpad 0-9 | Place action at current playhead (positions 0, 11, 22, ..., 100) |
| Alt+Click on empty canvas | Insert action at click position |
| Left / Right | Step one video frame |
| Ctrl+Left / Right | Fast frame step (default 6 — `editor.fastStepFrames`) |
| Shift+Left / Right | Move selected action(s) ±1 frame in time |
| Ctrl+Shift+Left / Right | Move selected action(s) ±N frames in time |
| Up / Down | Select previous / next action (with seek) |
| Ctrl+Up / Down | Select previous / next action across all loaded scripts |
| Shift+Up / Down | Nudge selected position ±5 (coarse) |
| Ctrl+Shift+Up / Down | Nudge selected position ±1 (fine) |
| Delete / Backspace | Delete selected actions |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / V / X | Copy / Paste / Cut |
| Ctrl+A | Select all |
| Ctrl+I | Invert positions |
| Ctrl+S | Save |
| W | Toggle audio waveform overlay |
| B | Add bookmark at current time |
| +/- | Zoom in / out |
| Escape | Clear selection / close editor |

When placing actions: press numpad without moving the playhead to refine the just-placed action's height; seek the playhead before pressing numpad to place a new action at the new time.

---

## Requirements

- Windows 10/11 (x64) or Linux (AppImage — Ubuntu 22+, Fedora 38+, SteamOS)
- [Intiface Central](https://intiface.com/central/) for Buttplug.io device support (optional)

---

## Building from Source

```bash
npm install
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && cd ..
npm run build
```

Requires Node.js 18+, Python 3.11+, and ffmpeg/ffprobe binaries in the `ffmpeg/` directory (or `ffmpeg-linux/` for Linux).

---

## License

See the repository license file.
