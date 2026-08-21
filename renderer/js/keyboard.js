// KeyboardHandler — Keyboard shortcuts for video playback

import { openKeyboardHelp, getPlayerShortcutGroups } from './keyboard-help.js';
import { t } from './i18n.js';

export class KeyboardHandler {
  constructor({ videoPlayer, connectionPanel, onOpenFile, scriptEditor, deviceSimulator, gapSkipEngine, onNavigate, onToggleLoop, onToggleQueue, onJumpChapter, onJumpBookmark, onLoadNext, onLoadPrev }) {
    this.player = videoPlayer;
    this.connectionPanel = connectionPanel || null;
    this.onOpenFile = onOpenFile || null;
    this.scriptEditor = scriptEditor || null;
    this.deviceSimulator = deviceSimulator || null;
    this.gapSkipEngine = gapSkipEngine || null;
    this.onNavigate = onNavigate || null;
    this.onToggleLoop = onToggleLoop || null;
    this.onToggleQueue = onToggleQueue || null;
    this.onJumpChapter = onJumpChapter || null;
    this.onJumpBookmark = onJumpBookmark || null;
    this.onLoadNext = onLoadNext || null;
    this.onLoadPrev = onLoadPrev || null;
    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => this._onKeyUp(e));
  }

  /**
   * Key-up handler — the two hold keys (Orgasm Switch X, Edge Hold Z).
   * Deliberately does NOT gate on focus/editor: if a hold was started we
   * must always release it, even if focus moved to an input mid-hold
   * (otherwise the device would be stuck driving the orgasm loop, or — for
   * Edge — stuck silent). The holds themselves are gated in _onKeyDown.
   */
  _onKeyUp(e) {
    if ((e.key === 'x' || e.key === 'X') && this._orgasmHoldActive) {
      this._orgasmHoldActive = false;
      if (this.onOrgasmHold) this.onOrgasmHold(false);
    }
    if ((e.key === 'z' || e.key === 'Z') && this._edgeHoldActive) {
      this._edgeHoldActive = false;
      if (this.onEdgeHold) this.onEdgeHold(false);
    }
  }

  _onKeyDown(e) {
    // Don't capture keys when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Alt+1/2/3 — top-level nav between Library / Playlists / Categories.
    // Slack/Discord/Notion convention; Nielsen #7 (flexibility for experts).
    // Skipped when the editor canvas owns input or a modal is on screen
    // (modals trap focus on themselves so the typical guard is a no-op,
    // but the editor handles its own keys without focusing — gate
    // explicitly).
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && this.onNavigate && !this.scriptEditor?.isOpen) {
      const navMap = { '1': 'library', '2': 'playlists', '3': 'categories' };
      const target = navMap[e.key];
      if (target) {
        e.preventDefault();
        this.onNavigate(target);
        return;
      }
    }

    // Ctrl+= / Ctrl+- / Ctrl+0 zoom the VR video, mirroring Ctrl+scroll and
    // trackpad pinch for anyone without a wheel. Handled ahead of the main
    // switch because these keys otherwise mean nothing here, and because
    // preventDefault MUST run or Chromium's page zoom rescales the whole UI.
    // '+' is included since Shift+= is how many layouts produce it.
    // Gated on the editor being closed, matching every other player-only
    // key here. The editor binds BARE +/=/- to its own timeline zoom and
    // calls stopPropagation, so a focused canvas already wins — but with
    // the editor open and focus elsewhere this would otherwise zoom the
    // video behind the editor, which is not what the user is looking at.
    if (e.ctrlKey && !e.altKey && !this.scriptEditor?.isOpen) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        if (this.onVRZoom) this.onVRZoom(1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        if (this.onVRZoom) this.onVRZoom(-1);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        if (this.onVRZoomReset) this.onVRZoomReset();
        return;
      }
    }

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        this.player.togglePlay();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        // Shift+Arrow pans the VR projection ±10° when a spherical
        // projection is active; otherwise the arrow seeks 5s.
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(-10, 0);
        } else {
          this.player.skip(-5);
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(10, 0);
        } else {
          this.player.skip(5);
        }
        break;

      case 'j':
      case 'J':
        e.preventDefault();
        this.player.skip(-10);
        break;

      case 'l':
      case 'L':
        e.preventDefault();
        // Shift+L toggles video loop; plain l/L seeks forward 10s.
        // The case catches both shifted-and-unshifted because some
        // keyboard layouts emit either depending on caps-lock; the
        // shiftKey check is the source of truth.
        if (e.shiftKey && this.onToggleLoop) {
          this.onToggleLoop();
        } else {
          this.player.skip(10);
        }
        break;

      case 'q':
      case 'Q':
        // Shift+Q toggles the queue panel. Plain Q is taken by the
        // editor's alternating-insert binding and is only meaningful
        // when the editor canvas has focus.
        if (e.shiftKey && this.onToggleQueue) {
          e.preventDefault();
          this.onToggleQueue();
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(0, -10); // pitch up (look up)
        } else {
          this.player.setVolume(this.player.video.volume + 0.05);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(0, 10); // pitch down (look down)
        } else {
          this.player.setVolume(this.player.video.volume - 0.05);
        }
        break;

      // Home / End — jump to the start or end of the video.
      //
      // These were listed in the `?` help from the beginning but never
      // actually implemented in the player: pressing them did nothing.
      // Found by the shortcut audit on 2026-08-15. The editor binds both
      // to its own actions (repeat-last-stroke / move-to-playhead), so
      // they are gated like every other player-only key.
      case 'Home':
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        this.player.seek(0);
        break;

      case 'End':
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        // Land a hair before the end: seeking exactly to `duration` fires
        // `ended` on some builds, which would advance the playlist instead
        // of showing the last frame.
        if (Number.isFinite(this.player.duration) && this.player.duration > 0) {
          this.player.seek(Math.max(0, this.player.duration - 0.05));
        }
        break;

      case 'm':
      case 'M':
        e.preventDefault();
        this.player.toggleMute();
        break;

      case 'f':
      case 'F':
        e.preventDefault();
        this.player.toggleFullscreen();
        break;

      case 'F11':
        e.preventDefault();
        this.player.toggleFullscreen();
        break;

      case 'h':
      case 'H':
        e.preventDefault();
        if (this.connectionPanel) {
          this.connectionPanel.toggle();
        }
        break;

      case 's':
      case 'S':
        e.preventDefault();
        this.player.captureScreenshot();
        break;

      case 'i':
      case 'I':
        e.preventDefault();
        this.player.toggleInfoOverlay();
        break;

      case 'a':
      case 'A':
        e.preventDefault();
        this.player.setLoopPoint('a');
        break;

      case 'b':
      case 'B':
        // Shift+B / Ctrl+B → bookmark prev/next (player-side bindings,
        // mirrors editor convention). Editor intercepts these when open,
        // so the guard below keeps player nav out of the way during
        // script authoring. Bare B is the A-B loop B-point.
        if (this.scriptEditor?.isOpen) {
          // Editor handles its own bookmark nav; let it through.
          break;
        }
        if (e.shiftKey && this.onJumpBookmark) {
          e.preventDefault();
          this.onJumpBookmark(-1);
        } else if ((e.ctrlKey || e.metaKey) && this.onJumpBookmark) {
          e.preventDefault();
          this.onJumpBookmark(+1);
        } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.player.setLoopPoint('b');
        }
        break;

      case 'r':
        e.preventDefault();
        this.player.cycleAspectRatio();
        break;

      case 'R':
        // Shift+R cycles the VR-as-flat playback mode (Off → Left → Right → Off).
        // Format is taken from the current video's stereo classification
        // — fed in by app.js after loadVideo runs. No-op if no format set.
        //
        // Ctrl+Shift+R used to open the VR Format panel here. Removed
        // 2026-08-14: zoom is now direct manipulation (Ctrl+scroll, trackpad
        // pinch, Ctrl+= / Ctrl+-), so the panel no longer needs a hotkey of
        // its own. It is still reachable from the player overflow menu and
        // the library kebab, both of which stay in sync with the gesture.
        e.preventDefault();
        if (this.onCycleVRFlatten) {
          this.onCycleVRFlatten();
        } else {
          this.player.cycleAspectRatio();
        }
        break;

      case '<':
      case ',':
        // Shift+, decrements playback speed (YouTube convention).
        // `,` arrives without Shift on US/UK layouts; `<` is what
        // some browsers report with Shift held. Accept both.
        // Bare `,` (no modifier) jumps to the previous chapter — the
        // editor's `,` is for selection and only fires when the editor
        // canvas has focus, so the guard below stays out of the way.
        if (e.shiftKey || e.key === '<') {
          e.preventDefault();
          this.player.cyclePlaybackRate(-1);
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey && !this.scriptEditor?.isOpen && this.onJumpChapter) {
          e.preventDefault();
          this.onJumpChapter(-1);
        }
        break;

      case '>':
      case '.':
        // Shift+. increments playback speed.
        // Bare `.` jumps to the next chapter — same guard as `,` above.
        if (e.shiftKey || e.key === '>') {
          e.preventDefault();
          this.player.cyclePlaybackRate(+1);
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey && !this.scriptEditor?.isOpen && this.onJumpChapter) {
          e.preventDefault();
          this.onJumpChapter(+1);
        }
        break;

      case 'd':
      case 'D':
        e.preventDefault();
        if (this.deviceSimulator) this.deviceSimulator.toggle();
        break;

      case 'e':
      case 'E':
        e.preventDefault();
        if (this.scriptEditor) this.scriptEditor.toggle();
        break;

      case 'v':
        e.preventDefault();
        if (this.onCycleVariant) this.onCycleVariant(1);
        break;

      case 'V':
        e.preventDefault();
        if (this.onCycleVariant) this.onCycleVariant(-1);
        break;

      case 'g':
        e.preventDefault();
        if (this.gapSkipEngine) this.gapSkipEngine.skipToNextAction();
        break;

      case 'G':
        e.preventDefault();
        if (this.gapSkipEngine) this.gapSkipEngine.skipToPreviousAction();
        break;

      case 'n':
      case 'N':
        // Next / previous video in the active queue. Same bindings the
        // detached pop-out window has always used, so the two windows
        // behave identically. Gated against the editor: swapping the
        // loaded video out from under an authoring session is worse
        // than a dead keypress. No-op with no queue, matching the
        // prev/next buttons (which stay hidden below 2 items).
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (this.onLoadNext) this.onLoadNext();
        break;

      case 'p':
      case 'P':
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (this.onLoadPrev) this.onLoadPrev();
        break;

      case 'o':
      case 'O':
        e.preventDefault();
        if (this.onOpenFile) this.onOpenFile();
        break;

      case 'x':
      case 'X':
        // Orgasm Switch — HOLD to swap the device(s) onto a short, looping
        // "orgasm" script; release to snap back to the main script (handled
        // in _onKeyUp). Gated against the editor so it doesn't fire during
        // authoring. keydown auto-repeats while held, so the _orgasmHoldActive
        // flag makes activation fire exactly once per physical press.
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (!this._orgasmHoldActive) {
          this._orgasmHoldActive = true;
          if (this.onOrgasmHold) this.onOrgasmHold(true);
        }
        break;

      case 'z':
      case 'Z':
        // Edge Hold — the Orgasm Switch's inverse, on the neighboring key:
        // HOLD to stop all device output while the video keeps playing;
        // release resumes the main script in sync at the current position
        // (handled in _onKeyUp). Same auto-repeat guard and editor gate as X.
        // (MattWritesNSFW, EroScripts #301.)
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (!this._edgeHoldActive) {
          this._edgeHoldActive = true;
          if (this.onEdgeHold) this.onEdgeHold(true);
        }
        break;

      case 'Escape':
        // Up Next dismiss runs FIRST so a visible card can be cleared
        // without also clearing the user's A-B loop. Other Esc handlers
        // only run when the card isn't showing.
        if (this.upNextEngine?.visible) {
          e.preventDefault();
          this.upNextEngine.dismiss();
          break;
        }
        e.preventDefault();
        if (this.scriptEditor?.isOpen) {
          this.scriptEditor.hide();
        }
        this.player.clearAbLoop();
        if (this.connectionPanel) {
          this.connectionPanel.hide();
        }
        break;

      // ? opens the keyboard-shortcut help overlay (Nielsen #7 +
      // #10 — make every shortcut discoverable from one binding).
      // Skipped when the editor is open — its own canvas-level
      // handler picks `?` up there and renders the editor-specific
      // group set.
      case '?':
        if (!this.scriptEditor?.isOpen) {
          e.preventDefault();
          openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
        }
        break;

      default:
        break;
    }
  }
}
