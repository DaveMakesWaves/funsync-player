/**
 * @vitest-environment jsdom
 * jsdom on purpose: the dialog builds real DOM through Modal (notes/CLAUDE.md
 * "Test environments").
 */
// Export Backup File asks first: keys and logins are left out unless ticked,
// and the option says why it is not recommended (Dave, 2026-11-26, "like RDM
// would").
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { openExportBackupDialog } from '../../renderer/components/export-backup-dialog.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
beforeEach(() => { _setBundlesForTests('en', EN, EN); document.body.innerHTML = ''; });

const q = (s) => document.querySelector(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the export question', () => {
  it('unticked by default; Export gives includeSecrets false', async () => {
    const done = openExportBackupDialog();
    await tick();
    expect(q('.modal-title').textContent).toBe(EN.settingsPanel.data.exportDialogTitle);
    expect(q('.export-backup__secrets-check').checked).toBe(false);
    expect(q('.export-backup__secrets-label').textContent).toBe(EN.settingsPanel.data.exportSecretsLabel);
    expect(q('.export-backup__secrets-hint').textContent).toMatch(/Not recommended/);
    expect(q('.export-backup__secrets-check').getAttribute('aria-describedby')).toBe(q('.export-backup__secrets-hint').id);
    q('.export-backup__go').click();
    await expect(done).resolves.toEqual({ includeSecrets: false });
  });

  it('ticked: the warning stands out, and Export gives includeSecrets true', async () => {
    const done = openExportBackupDialog();
    await tick();
    q('.export-backup__secrets-check').click();
    expect(q('.export-backup__secrets').classList.contains('export-backup__secrets--on')).toBe(true);
    q('.export-backup__go').click();
    await expect(done).resolves.toEqual({ includeSecrets: true });
  });

  it('Cancel: nothing is exported', async () => {
    const done = openExportBackupDialog();
    await tick();
    [...document.querySelectorAll('.modal-btn--secondary')].at(-1).click();
    await expect(done).resolves.toBeNull();
  });

  it('every locale has the words', () => {
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const d = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8')).settingsPanel.data;
      for (const k of ['exportDialogTitle', 'exportDialogBody', 'exportSecretsLabel', 'exportSecretsHint', 'exportDialogGo']) {
        expect(typeof d[k], `${l} ${k}`).toBe('string');
      }
    }
  });
});
