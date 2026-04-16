// StrokeControls — Stroke range and manual mode controls

export class StrokeControls {
  constructor({ handyManager, settings }) {
    this.handy = handyManager;
    this.settings = settings;
    this._min = settings.get('handy.slideMin') || 0;
    this._max = settings.get('handy.slideMax') || 100;
    this._element = null;
    this._create();
  }

  _create() {
    this._element = document.createElement('div');
    this._element.className = 'stroke-controls';
    this._element.innerHTML = `
      <label class="stroke-controls__label">Stroke Range</label>
      <div class="stroke-controls__row">
        <span class="stroke-controls__value" id="stroke-min-val">${this._min}</span>
        <input type="range" class="stroke-controls__slider"
               id="stroke-min-slider"
               min="0" max="100" value="${this._min}"
               aria-label="Minimum stroke position">
        <input type="range" class="stroke-controls__slider"
               id="stroke-max-slider"
               min="0" max="100" value="${this._max}"
               aria-label="Maximum stroke position">
        <span class="stroke-controls__value" id="stroke-max-val">${this._max}</span>
      </div>
      <div class="stroke-controls__manual">
        <label class="stroke-controls__manual-label">
          <input type="checkbox" id="manual-mode-toggle">
          Manual Mode (HAMP)
        </label>
        <input type="range" class="stroke-controls__speed-slider"
               id="manual-speed" min="0" max="100" value="50"
               disabled aria-label="Manual speed">
      </div>
    `;

    const minSlider = this._element.querySelector('#stroke-min-slider');
    const maxSlider = this._element.querySelector('#stroke-max-slider');
    const minVal = this._element.querySelector('#stroke-min-val');
    const maxVal = this._element.querySelector('#stroke-max-val');
    const manualToggle = this._element.querySelector('#manual-mode-toggle');
    const speedSlider = this._element.querySelector('#manual-speed');

    minSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (val < parseInt(maxSlider.value, 10)) {
        this._min = val;
        minVal.textContent = val;
        this._updateStrokeZone();
      } else {
        e.target.value = this._min;
      }
    });

    maxSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (val > parseInt(minSlider.value, 10)) {
        this._max = val;
        maxVal.textContent = val;
        this._updateStrokeZone();
      } else {
        e.target.value = this._max;
      }
    });

    manualToggle.addEventListener('change', async (e) => {
      speedSlider.disabled = !e.target.checked;
      if (e.target.checked) {
        await this.handy.hampStart(parseInt(speedSlider.value, 10));
      } else {
        await this.handy.hampStop();
      }
    });

    speedSlider.addEventListener('input', async (e) => {
      if (manualToggle.checked) {
        await this.handy.setHampVelocity(parseInt(e.target.value, 10));
      }
    });
  }

  async _updateStrokeZone() {
    this.settings.set('handy.slideMin', this._min);
    this.settings.set('handy.slideMax', this._max);
    if (this.handy.connected) {
      await this.handy.setStrokeZone(this._min, this._max);
    }
  }

  get element() {
    return this._element;
  }
}
