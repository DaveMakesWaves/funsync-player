// VideoPlayer — HTML5 video wrapper with custom controls

/**
 * Format seconds into human-readable time string.
 * @param {number} seconds
 * @returns {string} e.g. "1:23" or "1:01:23"
 */
export function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');

  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${m}:${pad(sec)}`;
}

export class VideoPlayer {
  constructor({ videoElement, controlsElement, containerElement }) {
    this.video = videoElement;
    this.controls = controlsElement;
    this.container = containerElement;

    this._controlsTimeout = null;
    this._cursorTimeout = null;
    this._isSeeking = false;
    this._clickTimer = null;
    this._abLoop = { a: null, b: null };
    this._infoVisible = false;
    this._aspectModes = ['contain', 'cover', '16 / 9', '4 / 3'];
    this._aspectIndex = 0;
    this._centerFlashTimer = null;
    this.onProgressHover = null; // callback: (timeSeconds) => {}
    this.onSeekDrag = null; // callback: (timeSeconds) => {} — called during scrub

    this._cacheElements();
    this._bindEvents();
  }

  _cacheElements() {
    this.btnPlay = document.getElementById('btn-play');
    this.iconPlay = this.btnPlay.querySelector('.icon-play');
    this.iconPause = this.btnPlay.querySelector('.icon-pause');

    this.btnMute = document.getElementById('btn-mute');
    this.iconVolume = this.btnMute.querySelector('.icon-volume');
    this.iconMuted = this.btnMute.querySelector('.icon-muted');
    this.volumeSlider = document.getElementById('volume-slider');

    this.btnFullscreen = document.getElementById('btn-fullscreen');
    this.iconExpand = this.btnFullscreen.querySelector('.icon-expand');
    this.iconCompress = this.btnFullscreen.querySelector('.icon-compress');

    this.btnPip = document.getElementById('btn-pip');

    this.timeCurrent = document.getElementById('time-current');
    this.timeDuration = document.getElementById('time-duration');

    this.progressContainer = document.getElementById('progress-container');
    this.progressBar = document.getElementById('progress-bar');
    this.progressThumb = document.getElementById('progress-thumb');
    this.bufferedBar = document.getElementById('buffered-bar');

    this.progressTooltip = document.getElementById('progress-tooltip');
    this.tooltipTime = document.getElementById('tooltip-time');

    this.centerPlayBtn = document.getElementById('center-play-btn');
    this.centerIconPlay = this.centerPlayBtn.querySelector('.center-play__icon--play');
    this.centerIconPause = this.centerPlayBtn.querySelector('.center-play__icon--pause');
    this.centerIconReplay = this.centerPlayBtn.querySelector('.center-play__icon--replay');
    this.iconReplay = this.btnPlay.querySelector('.icon-replay');
  }

  _bindEvents() {
    // Play/pause — delayed click avoids conflict with double-click fullscreen
    this.btnPlay.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => {
      clearTimeout(this._clickTimer);
      this._clickTimer = setTimeout(() => this.togglePlay(), 250);
    });
    this.video.addEventListener('dblclick', () => {
      clearTimeout(this._clickTimer);
      this.toggleFullscreen();
    });
    this.video.addEventListener('play', () => {
      this._ended = false;
      this._updatePlayButton(true);
      // Remove heatmap preview mode on first play
      this.progressContainer.classList.remove('progress--preview');
    });
    this.video.addEventListener('pause', () => this._updatePlayButton(false));
    this.video.addEventListener('ended', () => this._onEnded());

    // Center play/pause overlay — click to toggle
    this.centerPlayBtn.addEventListener('click', () => this.togglePlay());
    // Double-click on center button should fullscreen (same as video)
    this.centerPlayBtn.addEventListener('dblclick', () => {
      clearTimeout(this._clickTimer);
      this.toggleFullscreen();
    });

    // Time updates
    this.video.addEventListener('timeupdate', () => this._onTimeUpdate());
    this.video.addEventListener('loadedmetadata', () => this._onMetadataLoaded());
    this.video.addEventListener('progress', () => this._updateBuffered());

    // Volume
    this.btnMute.addEventListener('click', () => this.toggleMute());
    this.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value / 100));

    // Fullscreen
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this._updateFullscreenButton());

    // PiP
    this.btnPip.addEventListener('click', () => this.togglePip());

    // Progress bar seeking
    this.progressContainer.addEventListener('mousedown', (e) => this._startSeek(e));
    this.progressContainer.addEventListener('mousemove', (e) => this._onProgressHover(e));
    document.addEventListener('mousemove', (e) => this._onSeekDrag(e));
    document.addEventListener('mouseup', () => this._endSeek());

    // Controls visibility
    this.container.addEventListener('mousemove', () => this._showControls());
    this.container.addEventListener('mouseleave', () => this._hideControlsDelayed());
  }

  // --- Public API ---

  loadSource(url, filename) {
    this.video.src = url;
    this.video.load();

    // Reset progress bar to start position
    this.progressBar.style.width = '0%';
    this.progressThumb.style.left = '0%';
    this.progressContainer.setAttribute('aria-valuenow', '0');
    this.timeCurrent.textContent = '0:00';
    this.timeDuration.textContent = '0:00';

    // Show heatmap at full height until first play (reset first in case of rapid loads)
    this.progressContainer.classList.remove('progress--preview');
    this.progressContainer.classList.add('progress--preview');

    // Show controls briefly so user knows the player is active
    this._showControls();
    // Show center play button so user knows to click play
    this._updateCenterPlay(false);
  }

  togglePlay() {
    if (this._ended) {
      this.replay();
      return;
    }
    if (this.video.paused || this.video.ended) {
      this.video.play();
    } else {
      this.video.pause();
    }
  }

  replay() {
    this._ended = false;
    this.video.currentTime = 0;
    this.video.play();
  }

  play() {
    return this.video.play();
  }

  pause() {
    this.video.pause();
  }

  get paused() {
    return this.video.paused;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get duration() {
    return this.video.duration;
  }

  seek(time) {
    if (isFinite(time) && time >= 0 && time <= this.video.duration) {
      this.video.currentTime = time;
    }
  }

  skip(seconds) {
    this.seek(this.video.currentTime + seconds);
  }

  /**
   * Step forward or backward by one video frame.
   * Pauses the video first (OFS convention).
   * @param {1|-1} direction — 1 = forward, -1 = backward
   */
  stepFrame(direction) {
    this.video.pause();
    const fps = this._estimateFps();
    const newTime = Math.max(0, this.video.currentTime + direction / fps);
    if (isFinite(newTime)) {
      this.video.currentTime = Math.min(newTime, this.video.duration || Infinity);
    }
  }

  /**
   * Set the FPS from external metadata (e.g. backend ffprobe).
   * @param {number} fps
   */
  setFps(fps) {
    if (fps > 0 && isFinite(fps)) {
      this._fps = fps;
    }
  }

  _estimateFps() {
    return this._fps || 30;
  }

  setVolume(level) {
    const clamped = Math.max(0, Math.min(1, level));
    this.video.volume = clamped;
    this.volumeSlider.value = Math.round(clamped * 100);
    this._updateMuteButton();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this._updateMuteButton();
  }

  async toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await this.container.requestFullscreen();
    }
  }

  async togglePip() {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await this.video.requestPictureInPicture();
    }
  }

  // --- Private ---

  _onEnded() {
    this._ended = true;
    // Show replay icons in both the bar button and center overlay
    this.iconPlay.hidden = true;
    this.iconPause.hidden = true;
    if (this.iconReplay) this.iconReplay.hidden = false;
    this.btnPlay.setAttribute('aria-label', 'Replay');
    this.btnPlay.title = 'Replay (K)';

    // Center overlay — show replay icon persistently
    clearTimeout(this._centerFlashTimer);
    this.centerPlayBtn.classList.remove('center-play--flash');
    this.centerIconPlay.hidden = true;
    this.centerIconPause.hidden = true;
    if (this.centerIconReplay) this.centerIconReplay.hidden = false;
    this.centerPlayBtn.classList.add('center-play--visible');
    this.centerPlayBtn.setAttribute('aria-label', 'Replay');
  }

  _updatePlayButton(isPlaying) {
    this.iconPlay.hidden = isPlaying;
    this.iconPause.hidden = !isPlaying;
    if (this.iconReplay) this.iconReplay.hidden = true;
    this.btnPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    this.btnPlay.title = isPlaying ? 'Pause (K)' : 'Play (K)';
    this._updateCenterPlay(isPlaying);
  }

  _updateMuteButton() {
    const muted = this.video.muted || this.video.volume === 0;
    this.iconVolume.hidden = muted;
    this.iconMuted.hidden = !muted;
    this.btnMute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  _updateFullscreenButton() {
    const isFs = !!document.fullscreenElement;
    this.iconExpand.hidden = isFs;
    this.iconCompress.hidden = !isFs;
    this.btnFullscreen.setAttribute('aria-label', isFs ? 'Exit fullscreen' : 'Fullscreen');
  }

  _updateCenterPlay(isPlaying) {
    clearTimeout(this._centerFlashTimer);
    this.centerPlayBtn.classList.remove('center-play--flash', 'center-play--visible');
    if (this.centerIconReplay) this.centerIconReplay.hidden = true;

    if (isPlaying) {
      // Flash the pause icon briefly, then hide
      this.centerIconPlay.hidden = true;
      this.centerIconPause.hidden = false;
      this.centerPlayBtn.classList.add('center-play--flash');
      this._centerFlashTimer = setTimeout(() => {
        this.centerPlayBtn.classList.remove('center-play--flash');
      }, 500);
    } else {
      // Paused — show play icon persistently
      this.centerIconPlay.hidden = false;
      this.centerIconPause.hidden = true;
      this.centerPlayBtn.classList.add('center-play--visible');
    }

    this.centerPlayBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  _onTimeUpdate() {
    if (this._isSeeking) return;
    const { currentTime, duration } = this.video;
    if (!isFinite(duration)) return;

    const pct = (currentTime / duration) * 100;
    this.progressBar.style.width = `${pct}%`;
    this.progressThumb.style.left = `${pct}%`;
    this.progressContainer.setAttribute('aria-valuenow', Math.round(pct));

    this.timeCurrent.textContent = this._formatTime(currentTime);
  }

  _onMetadataLoaded() {
    this.timeDuration.textContent = this._formatTime(this.video.duration);

    // Resolution badge
    const h = this.video.videoHeight;
    let label = '';
    if (h >= 2160) label = '4K';
    else if (h >= 1440) label = '1440p';
    else if (h >= 1080) label = '1080p';
    else if (h >= 720) label = '720p';
    else if (h >= 480) label = '480p';
    else if (h > 0) label = `${h}p`;

    this._resolutionLabel = label;
  }

  _updateBuffered() {
    if (this.video.buffered.length > 0) {
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      const pct = (end / this.video.duration) * 100;
      this.bufferedBar.style.width = `${pct}%`;
    }
  }

  // --- Seeking ---

  _startSeek(e) {
    this._isSeeking = true;
    this._seekToPosition(e);
  }

  _onSeekDrag(e) {
    if (!this._isSeeking) return;
    this._seekToPosition(e);
  }

  _endSeek() {
    this._isSeeking = false;
  }

  _seekToPosition(e) {
    const rect = this.progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * this.video.duration;
    if (isFinite(time)) {
      this.video.currentTime = time;
      this.progressBar.style.width = `${pct * 100}%`;
      this.progressThumb.style.left = `${pct * 100}%`;

      // Notify for HDSP scrub preview
      if (this._isSeeking && this.onSeekDrag) {
        this.onSeekDrag(time);
      }
    }
  }

  _onProgressHover(e) {
    const rect = this.progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = pct * this.video.duration;

    if (isFinite(time)) {
      this.tooltipTime.textContent = this._formatTime(time);
      this.progressTooltip.style.left = `${pct * 100}%`;

      // Notify for thumbnail preview
      if (this.onProgressHover) {
        this.onProgressHover(time);
      }
    }
  }

  // --- Controls Visibility ---

  _showControls() {
    this.container.classList.add('controls-visible');
    this.container.style.cursor = '';
    clearTimeout(this._controlsTimeout);
    clearTimeout(this._cursorTimeout);
    this._hideControlsDelayed();
  }

  _hideControlsDelayed() {
    clearTimeout(this._controlsTimeout);
    clearTimeout(this._cursorTimeout);
    this._controlsTimeout = setTimeout(() => {
      if (!this.video.paused) {
        this.container.classList.remove('controls-visible');
        this.container.style.cursor = 'none';
      }
    }, 1500);
  }

  // --- Screenshot ---

  captureScreenshot() {
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot_${this._formatTime(this.video.currentTime).replace(/:/g, '-')}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // --- Info Overlay ---

  toggleInfoOverlay() {
    this._infoVisible = !this._infoVisible;
    let overlay = document.getElementById('info-overlay');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'info-overlay';
      overlay.className = 'info-overlay';
      this.container.appendChild(overlay);
    }

    if (this._infoVisible) {
      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      const codec = this.video.videoWidth ? 'H.264' : '—';
      overlay.innerHTML = `
        <div>Resolution: ${w}x${h}</div>
        <div>Duration: ${this._formatTime(this.video.duration)}</div>
        <div>Current: ${this._formatTime(this.video.currentTime)}</div>
        <div>Volume: ${Math.round(this.video.volume * 100)}%</div>
        <div>Playback Rate: ${this.video.playbackRate}x</div>
      `;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
  }

  // --- A-B Loop ---

  setLoopPoint(point) {
    if (point === 'a') {
      this._abLoop.a = this.video.currentTime;
      console.log(`Loop A set: ${this._formatTime(this._abLoop.a)}`);
    } else if (point === 'b') {
      this._abLoop.b = this.video.currentTime;
      console.log(`Loop B set: ${this._formatTime(this._abLoop.b)}`);
      if (this._abLoop.a !== null && this._abLoop.b !== null) {
        this._startAbLoop();
      }
    }
  }

  clearAbLoop() {
    this._abLoop = { a: null, b: null };
    console.log('A-B loop cleared');
  }

  _startAbLoop() {
    const checkLoop = () => {
      if (this._abLoop.a === null || this._abLoop.b === null) return;
      if (this.video.currentTime >= this._abLoop.b) {
        this.video.currentTime = this._abLoop.a;
      }
      if (this._abLoop.a !== null && this._abLoop.b !== null) {
        requestAnimationFrame(checkLoop);
      }
    };
    requestAnimationFrame(checkLoop);
  }

  // --- Aspect Ratio ---

  cycleAspectRatio() {
    this._aspectIndex = (this._aspectIndex + 1) % this._aspectModes.length;
    const mode = this._aspectModes[this._aspectIndex];

    if (mode === 'contain' || mode === 'cover') {
      this.video.style.objectFit = mode;
      this.video.style.aspectRatio = '';
    } else {
      this.video.style.objectFit = 'contain';
      this.video.style.aspectRatio = mode;
    }

    const labels = { contain: 'Fit', cover: 'Fill', '16 / 9': '16:9', '4 / 3': '4:3' };
    console.log(`Aspect ratio: ${labels[mode]}`);
  }

  // --- Subtitles ---

  async loadSubtitles(file) {
    // Remove existing tracks and revoke old blob URLs
    const existing = this.video.querySelectorAll('track');
    existing.forEach((t) => {
      if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
      t.remove();
    });

    // Read file content
    let text = typeof file.textContent === 'string' ? file.textContent : await file.text();
    const name = file.name || 'subtitles';
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();

    // Convert SRT to VTT (HTML5 <track> only supports WebVTT)
    if (ext === '.srt') {
      text = 'WEBVTT\n\n' + text.replace(/\r\n/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    const blob = new Blob([text], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = name.replace(/\.[^/.]+$/, '');
    track.src = url;
    track.default = true;
    this.video.appendChild(track);

    // Enable the track
    this.video.textTracks[0].mode = 'showing';

    // Show subtitle indicator
    const badge = document.getElementById('subtitle-badge');
    if (badge) badge.hidden = false;
  }

  // --- Utils ---

  _formatTime(seconds) {
    return formatTime(seconds);
  }
}
