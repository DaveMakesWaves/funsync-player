// Export Backup File's question (Dave, 2026-11-26: "add the option to
// include them in but exclude them as default, like RDM would, reccomends its
// insecure to keep them in the backup but doesnt exclude it as an option").
//
// The backup holds playlists, categories, tags, associations and settings.
// Keys and logins (the Handy key, the Autoblow token, the EroScripts login,
// the Audience keys) are left out unless "Include keys and logins" is ticked,
// which says why it is not recommended. Remote Desktop Manager's export works
// the same way.
import { Modal } from './modal.js';
import { t } from '../js/i18n.js';

/**
 * @returns {Promise<{ includeSecrets: boolean } | null>} null when cancelled
 */
export function openExportBackupDialog() {
  return Modal.open({
    title: t('settingsPanel.data.exportDialogTitle'),
    panelClass: 'export-backup-panel',
    onRender(body, close) {
      const msg = document.createElement('div');
      msg.className = 'modal-message';
      msg.textContent = t('settingsPanel.data.exportDialogBody');
      body.appendChild(msg);

      const row = document.createElement('label');
      row.className = 'export-backup__secrets';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'export-backup__secrets-check';
      check.checked = false;                      // left out unless asked for
      const text = document.createElement('span');
      text.className = 'export-backup__secrets-text';
      const label = document.createElement('span');
      label.className = 'export-backup__secrets-label';
      label.textContent = t('settingsPanel.data.exportSecretsLabel');
      const hint = document.createElement('span');
      hint.className = 'export-backup__secrets-hint';
      hint.id = 'export-backup-secrets-hint';
      hint.textContent = t('settingsPanel.data.exportSecretsHint');
      check.setAttribute('aria-describedby', hint.id);
      text.append(label, hint);
      row.append(check, text);
      body.appendChild(row);

      // Ticked: the warning stands out (it was there all along).
      const paint = () => row.classList.toggle('export-backup__secrets--on', check.checked);
      check.addEventListener('change', paint);
      paint();

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'modal-btn modal-btn--secondary';
      cancel.textContent = t('common.cancel');
      cancel.addEventListener('click', () => close(null));
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'modal-btn modal-btn--primary export-backup__go';
      go.textContent = t('settingsPanel.data.exportDialogGo');
      go.addEventListener('click', () => close({ includeSecrets: check.checked === true }));
      actions.append(cancel, go);
      body.appendChild(actions);
    },
    initialFocus: (body) => body.querySelector('.export-backup__go'),
  });
}
