// KeyboardHandler — Keyboard shortcuts for video playback

export class KeyboardHandler {
  constructor({ videoPlayer, connectionPanel, onOpenFile, scriptEditor, deviceSimulator }) {
    this.player = videoPlayer;
    this.connectionPanel = connectionPanel || null;
    this.onOpenFile = onOpenFile || null;
    this.scriptEditor = scriptEditor || null;
    this.deviceSimulator = deviceSimulator || null;
    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    // Don't capture keys when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        this.player.togglePlay();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        this.player.skip(-5);
        break;

      case 'ArrowRight':
        e.preventDefault();
        this.player.skip(5);
        break;

      case 'j':
      case 'J':
        e.preventDefault();
        this.player.skip(-10);
        break;

      case 'l':
      case 'L':
        e.preventDefault();
        this.player.skip(10);
        break;

      case 'ArrowUp':
        e.preventDefault();
        this.player.setVolume(this.player.video.volume + 0.05);
        break;

      case 'ArrowDown':
        e.preventDefault();
        this.player.setVolume(this.player.video.volume - 0.05);
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
      case 'R':
        e.preventDefault();
        this.player.cycleAspectRatio();
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

      case 'o':
      case 'O':
        e.preventDefault();
        if (this.onOpenFile) this.onOpenFile();
        break;

      case 'Escape':
        e.preventDefault();
        if (this.scriptEditor?.isOpen) {
          this.scriptEditor.hide();
        }
        this.player.clearAbLoop();
        if (this.connectionPanel) {
          this.connectionPanel.hide();
        }
        break;

      default:
        break;
    }
  }
}
