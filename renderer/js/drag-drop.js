// DragDrop — File drop handler for video and funscript files

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
const FUNSCRIPT_EXTENSIONS = ['.funscript'];
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'];

export class DragDrop {
  constructor({ dropZoneElement, onVideoFile, onFunscriptFile, onSubtitleFile }) {
    this.dropZone = dropZoneElement || null;
    this.onVideoFile = onVideoFile;
    this.onFunscriptFile = onFunscriptFile;
    this.onSubtitleFile = onSubtitleFile || null;

    this._bindEvents();
  }

  _bindEvents() {
    // Drag-and-drop on the entire document
    document.addEventListener('dragenter', (e) => this._onDragEnter(e));
    document.addEventListener('dragover', (e) => this._onDragOver(e));
    document.addEventListener('dragleave', (e) => this._onDragLeave(e));
    document.addEventListener('drop', (e) => this._onDrop(e));

    // Browse button — use Electron's native file dialog
    const browseBtn = document.getElementById('btn-browse');
    if (browseBtn) {
      browseBtn.addEventListener('click', () => this._openNativeDialog());
    }
  }

  async _openNativeDialog() {
    try {
      const files = await window.funsync.openFileDialog();
      if (!files || files.length === 0) return;

      for (const fileData of files) {
        const ext = this._getExtension(fileData.name);

        if (VIDEO_EXTENSIONS.includes(ext)) {
          // For video: use file:// URL directly (no content transfer needed)
          this.onVideoFile({
            name: fileData.name,
            path: fileData.path,
            _isPathBased: true,
          });
        } else if (FUNSCRIPT_EXTENSIONS.includes(ext)) {
          const blob = new Blob([fileData.textContent], { type: 'application/json' });
          const file = new File([blob], fileData.name);
          file.path = fileData.path;
          this.onFunscriptFile(file);
        } else if (SUBTITLE_EXTENSIONS.includes(ext) && this.onSubtitleFile) {
          const blob = new Blob([fileData.textContent], { type: 'text/plain' });
          const file = new File([blob], fileData.name);
          this.onSubtitleFile(file);
        }
      }
    } catch (err) {
      console.error('File dialog error:', err);
    }
  }

  _onDragEnter(e) {
    e.preventDefault();
    if (this.dropZone) this.dropZone.classList.add('drop-zone--active');
  }

  _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  _onDragLeave(e) {
    e.preventDefault();
    if (e.relatedTarget === null || !document.contains(e.relatedTarget)) {
      if (this.dropZone) this.dropZone.classList.remove('drop-zone--active');
    }
  }

  _onDrop(e) {
    e.preventDefault();
    if (this.dropZone) this.dropZone.classList.remove('drop-zone--active');

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    for (const file of files) {
      const ext = this._getExtension(file.name);

      if (VIDEO_EXTENSIONS.includes(ext)) {
        this.onVideoFile(file);
      } else if (FUNSCRIPT_EXTENSIONS.includes(ext)) {
        this.onFunscriptFile(file);
      } else if (SUBTITLE_EXTENSIONS.includes(ext) && this.onSubtitleFile) {
        this.onSubtitleFile(file);
      }
    }
  }

  _getExtension(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot === -1) return '';
    return filename.slice(dot).toLowerCase();
  }
}
