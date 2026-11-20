// Update toasts — "Update vX available [Download]" and "vX ready [Restart Now]".
//
// One copy for every window that shows them: the main window and the
// detached player window (FT-101, also in v0.9.2). The updater in main sent
// its events to the main window only, and the pop-out had no toast container
// or handler, so someone watching in the pop-out never heard of an update.
// Both windows now get the events (electron/auto-updater.js) and show the
// same toasts from here. Download is safe to press in either window, or in
// both: electron-updater runs one download and hands a second press the
// same one.

import { t } from './i18n.js';
import { showToast } from './toast.js';

/** "Update vX available" with a Download button (15 s, like before). */
export function showUpdateAvailableToast(data, api = globalThis.window?.funsync) {
  const container = document.createElement('div');
  container.className = 'update-toast';

  const text = document.createElement('span');
  text.textContent = t('updater.available', { version: data?.version });
  container.appendChild(text);

  const btn = document.createElement('button');
  btn.className = 'update-toast__btn';
  btn.textContent = t('updater.download');
  btn.addEventListener('click', () => {
    api?.updaterDownload?.();
    btn.disabled = true;
    btn.textContent = t('updater.downloading');
  });
  container.appendChild(btn);

  return showToast(container, 'info', 15000);
}

/** "vX ready, restart to update" with Restart Now; stays until dismissed. */
export function showUpdateReadyToast(data, api = globalThis.window?.funsync) {
  const container = document.createElement('div');
  container.className = 'update-toast';

  const text = document.createElement('span');
  text.textContent = t('updater.ready', { version: data?.version });
  container.appendChild(text);

  const btn = document.createElement('button');
  btn.className = 'update-toast__btn';
  btn.textContent = t('updater.restartNow');
  btn.addEventListener('click', () => {
    api?.updaterInstall?.();
  });
  container.appendChild(btn);

  return showToast(container, 'info', 0); // Persistent until dismissed
}
