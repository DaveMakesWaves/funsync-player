// KeyboardHandler — Keyboard shortcuts for video playback

import { openKeyboardHelp, getPlayerShortcutGroups } from './keyboard-help.js';
import { t } from './i18n.js';

export class KeyboardHandler {
  constructor({ videoPlayer, connectionPanel, onOpenFile, scriptEditor, deviceSimulator, gapSkipEngine, onNavigate, onToggleLoop, onToggleQueue }) {
    this.player = videoPlayer;
    this.connectionPanel = connectionPanel || null;
    this.onOpenFile = onOpenFile || null;
    this.scriptEditor = scriptEditor || null;
    this.deviceSimulator = deviceSimulator || null;
    this.gapSkipEngine = gapSkipEngine || null;
    this.onNavigate = onNavigate || null;
    this.onToggleLoop = onToggleLoop || null;
    this.onToggleQueue = onToggleQueue || null;
    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
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
        e.preventDefault();
        this.player.setLoopPoint('b');
        break;

      case 'r':
        e.preventDefault();
        this.player.cycleAspectRatio();
        break;

      case 'R':
        // Shift+R cycles the VR-as-flat playback mode (Off → Left → Right → Off).
        // Ctrl+Shift+R opens the VR Format panel for the current video
        // — manual projection / eye / zoom / apply-to-folder overrides.
        // Format is taken from the current video's stereo classification
        // — fed in by app.js after loadVideo runs. No-op if no format set.
        e.preventDefault();
        if (e.ctrlKey) {
          if (this.onOpenVRFormat) this.onOpenVRFormat();
        } else if (this.onCycleVRFlatten) {
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
        if (e.shiftKey || e.key === '<') {
          e.preventDefault();
          this.player.cyclePlaybackRate(-1);
        }
        break;

      case '>':
      case '.':
        // Shift+. increments playback speed.
        if (e.shiftKey || e.key === '>') {
          e.preventDefault();
          this.player.cyclePlaybackRate(+1);
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

      case 'o':
      case 'O':
        e.preventDefault();
        if (this.onOpenFile) this.onOpenFile();
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
