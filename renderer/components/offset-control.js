// OffsetControl — Script offset slider for fine-tuning sync

export class OffsetControl {
  constructor({ handyManager, settings }) {
    this.handy = handyManager;
    this.settings = settings;
    this._offset = settings.get('handy.defaultOffset') || 0;
    this._element = null;
    this._create();
  }

  _create() {
    this._element = document.createElement('div');
    this._element.className = 'offset-control';
    this._element.innerHTML = `
      <label class="offset-control__label">Script Offset</label>
      <div class="offset-control__row">
        <input type="range" class="offset-control__slider"
               min="-500" max="500" step="10" value="${this._offset}"
               aria-label="Script offset in milliseconds">
        <input type="number" class="offset-control__number"
               min="-500" max="500" step="10" value="${this._offset}"
               aria-label="Script offset value">
        <span class="offset-control__unit">ms</span>
      </div>
    `;

    const slider = this._element.querySelector('.offset-control__slider');
    const number = this._element.querySelector('.offset-control__number');

    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      number.value = val;
      this._setOffset(val);
    });

    number.addEventListener('change', (e) => {
      const val = Math.max(-500, Math.min(500, parseInt(e.target.value, 10) || 0));
      slider.value = val;
      number.value = val;
      this._setOffset(val);
    });
  }

  async _setOffset(value) {
    this._offset = value;
    this.settings.set('handy.defaultOffset', value);
    if (this.handy.connected) {
      await this.handy.setOffset(value);
    }
  }

  get element() {
    return this._element;
  }

  get offset() {
    return this._offset;
  }
}
