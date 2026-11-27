// The app's identity on Windows (its AppUserModelID): what the taskbar and
// notifications file the app's windows and toasts under.
//
// The installed app uses the installer's appId (electron-builder.yml), so a
// notification shows FunSync's name and logo (Dave, 2026-11-22). A dev build
// (`npx electron .`) runs as electron.exe and must NOT use that id: under it,
// Electron made a Start-menu "Electron" shortcut for the id pointing at the
// dev electron.exe (found 2026-11-24, Dave: "the app icon is default electron
// icon again"), and from then on Windows showed Electron's logo for that id,
// the dev build's taskbar button and the installed app's alike. A dev build
// has its own id, and its windows carry the FunSync icon themselves
// (BrowserWindow.setAppDetails), as the installed exe carries it.
//
// It came back on 2026-11-25 (13:12, a feed notification): Electron 41 writes
// that shortcut itself for toast notifications (windows_toast_activator.cc
// EnsureShortcut): `<Start menu>\Programs\<exe product name>.lnk`, "Electron"
// for the stock electron.exe, with the app's id and Toast Activator CLSID and
// NO icon, so Windows shows electron.exe's logo for the id again. It keeps an
// existing one whose target, working folder, id and CLSID match (it never
// checks the icon, and adopts the CLSID on disk), so a dev build writes that
// shortcut itself at start, with FunSync's icon: `devShortcut()`.
const path = require('path');

/** electron-builder.yml `appId` (a test keeps the two equal). */
const INSTALLED_APP_ID = 'com.funsync.player';

/** A fixed Toast Activator CLSID for dev builds (Electron's default is a new one each run). */
const DEV_TOAST_CLSID = '{AD2EC44A-045A-4FEA-A422-C0FA55E9ABC8}';

/** The stock electron.exe's product name: the name Electron gives its notification shortcut. */
const ELECTRON_EXE_PRODUCT = 'Electron';

/**
 * @param {{ packaged: boolean, platform?: string, appRoot: string }} opts
 * @returns {null | { appId: string, windowDetails: object|null, toastClsid: string|null }} null off Windows.
 */
function appIdentity({ packaged, platform = process.platform, appRoot }) {
  if (platform !== 'win32') return null;
  if (packaged) return { appId: INSTALLED_APP_ID, windowDetails: null, toastClsid: null };
  const appId = `${INSTALLED_APP_ID}.dev`;
  return {
    appId,
    toastClsid: DEV_TOAST_CLSID,
    windowDetails: {
      appId,
      appIconPath: path.join(appRoot, 'assets', 'icons', 'icon.ico'),
      appIconIndex: 0,
      relaunchDisplayName: 'FunSync Player (dev)',
    },
  };
}

/**
 * The Start-menu shortcut Electron would make for a dev build's notifications,
 * as Electron would make it (so it keeps it) but with FunSync's icon.
 * @param {{ identity: ReturnType<typeof appIdentity>, execPath: string, programsDir: string }} o
 * @returns {null | { path: string, options: object }} null when not a dev build on Windows.
 */
function devShortcut({ identity, execPath, programsDir }) {
  if (!identity || !identity.windowDetails || !identity.toastClsid || !execPath || !programsDir) return null;
  return {
    path: path.join(programsDir, `${ELECTRON_EXE_PRODUCT}.lnk`),
    options: {
      target: execPath,
      cwd: path.dirname(execPath),
      args: '',
      description: identity.windowDetails.relaunchDisplayName,
      appUserModelId: identity.appId,
      toastActivatorClsid: identity.toastClsid,
      icon: identity.windowDetails.appIconPath,
      iconIndex: 0,
    },
  };
}

module.exports = { appIdentity, devShortcut, INSTALLED_APP_ID, DEV_TOAST_CLSID };
