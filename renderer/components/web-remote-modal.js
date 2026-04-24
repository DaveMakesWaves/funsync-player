// WebRemoteModal — dedicated modal for phone/tablet remote setup. Shows the
// LAN URL, a QR code, and a short explainer. Pulls the backend IP from
// `/network-info` each time the modal opens so cached values don't lie when
// the user switches networks.

import { Modal } from './modal.js';

/**
 * @param {object} opts
 * @param {import('../js/data-service.js').DataService|object} opts.settings
 *     — needs .get('backend.port')
 */
export async function openWebRemoteModal({ settings } = {}) {
  const port = settings?.get?.('backend.port') || 5123;

  await Modal.open({
    title: 'Web Remote',
    onRender: (body, _close) => {
      const wrap = document.createElement('div');
      wrap.className = 'web-remote-modal';

      // Experimental banner — match the styling used in Sync tab and VR
      // modal for consistency.
      const expBanner = document.createElement('div');
      expBanner.style.cssText = 'padding:8px 12px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:10px';
      expBanner.innerHTML =
        '<span style="font-weight:600;color:#ffc107;font-size:11px;letter-spacing:0.5px">EXPERIMENTAL</span>' +
        '<span style="font-size:11px;opacity:0.85;margin-left:6px">Web Remote is still being polished — phone-side device sync and reconnection edge cases may surface.</span>';
      wrap.appendChild(expBanner);

      const intro = document.createElement('div');
      intro.className = 'web-remote-modal__intro';
      intro.textContent =
        'Open your library on a phone or tablet in a browser on the same Wi-Fi. ' +
        'Scan the QR code with the device’s camera, or type the URL.';
      wrap.appendChild(intro);

      const row = document.createElement('div');
      row.className = 'web-remote-modal__row';

      // Left side: URL + status line + features
      const info = document.createElement('div');
      info.className = 'web-remote-modal__info';

      const urlLabel = document.createElement('label');
      urlLabel.className = 'web-remote-modal__label';
      urlLabel.textContent = 'URL';
      info.appendChild(urlLabel);

      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.readOnly = true;
      urlInput.className = 'web-remote-modal__url';
      urlInput.value = '(detecting…)';
      urlInput.addEventListener('click', () => urlInput.select());
      info.appendChild(urlInput);

      const features = document.createElement('ul');
      features.className = 'web-remote-modal__features';
      features.innerHTML = `
        <li>Browse and play videos on the phone</li>
        <li>Connected devices follow the phone's playback</li>
        <li>Only one phone or VR headset drives devices at a time</li>
      `;
      info.appendChild(features);

      row.appendChild(info);

      // Right side: QR code (auto-populated after we fetch the IP)
      const qrWrap = document.createElement('div');
      qrWrap.className = 'web-remote-modal__qr';
      qrWrap.title = 'Scan with your phone’s camera';
      row.appendChild(qrWrap);

      wrap.appendChild(row);
      body.appendChild(wrap);

      // Populate URL + QR asynchronously.
      _populate(urlInput, qrWrap, port);
    },
  });
}

async function _populate(urlInput, qrWrap, port) {
  let ip = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/network-info`);
    if (res.ok) {
      const data = await res.json();
      ip = data.ip || '127.0.0.1';
    }
  } catch { /* backend down */ }

  if (!ip) {
    urlInput.value = 'Backend not running';
    qrWrap.innerHTML = '';
    return;
  }

  const url = `http://${ip}:${port}/remote/`;
  urlInput.value = url;
  try {
    const mod = await import('../../node_modules/qrcode-generator/dist/qrcode.mjs');
    const qrcode = mod.default || mod;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrWrap.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1 });
  } catch {
    qrWrap.innerHTML = '<div class="web-remote-modal__qr-fallback">QR unavailable</div>';
  }
}
