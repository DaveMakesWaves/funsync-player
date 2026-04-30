// DragDrop — File drop handler for video and funscript files
//
// Visual-feedback pass (2026-04-28): pre-2026-04-28 the class accepted a
// `dropZoneElement` but the only call site (`renderer/js/app.js`) passed
// `null`, so the dragenter/dragleave class toggle never landed anywhere
// — drops were entirely silent visually. Now the class internally
// resolves the `#drop-zone-overlay` element if no override is passed,
// detects rejection during `dragover` (so the rejection visual fires
// BEFORE the user releases — Nielsen #5 error prevention), and surfaces
// a toast for unsupported drops.

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
const FUNSCRIPT_EXTENSIONS = ['.funscript'];
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'];
const ALL_ACCEPTED = [...VIDEO_EXTENSIONS, ...FUNSCRIPT_EXTENSIONS, ...SUBTITLE_EXTENSIONS];

export class DragDrop {
  constructor({ dropZoneElement, onVideoFile, onFunscriptFile, onSubtitleFile, onUnsupported }) {
    // Override is allowed but the default is the global overlay.
    this.dropZone = dropZoneElement === undefined
      ? document.getElementById('drop-zone-overlay')
      : dropZoneElement;
    this.onVideoFile = onVideoFile;
    this.onFunscriptFile = onFunscriptFile;
    this.onSubtitleFile = onSubtitleFile || null;
    // Optional toast hook for unsupported drops; if not provided we
    // fall back to a console warning. Wired by app.js to showToast.
    this.onUnsupported = onUnsupported || ((msg) => console.warn(msg));

    // Counter to handle nested dragenter/leave events. Browsers fire
    // dragleave when the cursor moves between child elements; we only
    // want to hide the overlay when it leaves the document entirely.
    this._dragDepth = 0;

    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener('dragenter', (e) => this._onDragEnter(e));
    document.addEventListener('dragover', (e) => this._onDragOver(e));
    document.addEventListener('dragleave', (e) => this._onDragLeave(e));
    document.addEventListener('drop', (e) => this._onDrop(e));

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
        } else {
          this.onUnsupported(`Unsupported file type: ${fileData.name}`);
        }
      }
    } catch (err) {
      console.error('File dialog error:', err);
    }
  }

  /**
   * Show the drop-zone overlay. Toggles the rejection variant based on
   * whether the dragged data includes any supported file types.
   * @param {DragEvent} e
   */
  _showOverlay(e) {
    if (!this.dropZone) return;
    this.dropZone.hidden = false;
    this.dropZone.setAttribute('aria-hidden', 'false');
    this.dropZone.classList.add('drop-zone--active');
    // Detect rejection — items[i].kind === 'file' carries `type` (MIME)
    // but extensions aren't in the dataTransfer until drop. Best we can
    // do during dragover is check `type`. If at least one item looks
    // like an accepted MIME prefix (video/, audio/, text/, application/
    // for funscript), we accept; if every item is something else (image
    // or empty type with file kind), we reject.
    const items = Array.from(e.dataTransfer?.items || []);
    if (items.length > 0 && items.every(item => item.kind === 'file' && this._isObviouslyRejected(item.type))) {
      this.dropZone.classList.add('drop-zone-overlay--reject');
    } else {
      this.dropZone.classList.remove('drop-zone-overlay--reject');
    }
  }

  _hideOverlay() {
    if (!this.dropZone) return;
    this.dropZone.hidden = true;
    this.dropZone.setAttribute('aria-hidden', 'true');
    this.dropZone.classList.remove('drop-zone--active');
    this.dropZone.classList.remove('drop-zone-overlay--reject');
  }

  /**
   * MIME-based heuristic for rejection during dragover (extensions
   * aren't accessible until drop). Returns true if the type is clearly
   * not one of our supported formats. Conservative — when in doubt we
   * accept and let the drop handler do the real extension check.
   */
  _isObviouslyRejected(mime) {
    if (!mime) return false; // empty MIME is common; defer judgement
    return mime.startsWith('image/')
        || mime.startsWith('font/')
        || mime === 'application/zip'
        || mime === 'application/pdf'
        || mime === 'application/x-msdownload';
  }

  _onDragEnter(e) {
    e.preventDefault();
    this._dragDepth++;
    this._showOverlay(e);
  }

  _onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    // Re-evaluate rejection on every dragover — the user may drag
    // multiple file types in sequence.
    this._showOverlay(e);
  }

  _onDragLeave(e) {
    e.preventDefault();
    this._dragDepth = Math.max(0, this._dragDepth - 1);
    // Only hide when we've left every nested element AND the drag has
    // truly left the document (relatedTarget null for the latter).
    if (this._dragDepth === 0 || e.relatedTarget === null || !document.contains(e.relatedTarget)) {
      this._dragDepth = 0;
      this._hideOverlay();
    }
  }

  _onDrop(e) {
    e.preventDefault();
    this._dragDepth = 0;
    this._hideOverlay();

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    let acceptedCount = 0;
    let rejectedNames = [];
    for (const file of files) {
      const ext = this._getExtension(file.name);
      if (VIDEO_EXTENSIONS.includes(ext)) {
        this.onVideoFile(file);
        acceptedCount++;
      } else if (FUNSCRIPT_EXTENSIONS.includes(ext)) {
        this.onFunscriptFile(file);
        acceptedCount++;
      } else if (SUBTITLE_EXTENSIONS.includes(ext) && this.onSubtitleFile) {
        this.onSubtitleFile(file);
        acceptedCount++;
      } else {
        rejectedNames.push(file.name);
      }
    }
    if (rejectedNames.length > 0) {
      const supportedList = ALL_ACCEPTED.join(', ');
      this.onUnsupported(
        rejectedNames.length === 1
          ? `Unsupported file: ${rejectedNames[0]}. Supported types: ${supportedList}`
          : `Unsupported files: ${rejectedNames.join(', ')}. Supported types: ${supportedList}`
      );
    }
  }

  _getExtension(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot === -1) return '';
    return filename.slice(dot).toLowerCase();
  }
}
