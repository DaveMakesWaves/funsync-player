/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Switching script variant must actually reach the Autoblow.
//
// lr_x3, EroScripts #333: "if I have more than 1 script and I select another
// script that one doesn't get loaded onto the device. It's still
// playing/syncing the already loaded script. Only if I do a quick
// disconnect/connect in the device window the selected script gets loaded. On
// all other devices (Handy, Tcode, buttplug.io) it's working though."
//
// Cause: `_tryStartAutoblowSync` short-circuits the upload when
// `autoblowSync.scriptReady` is already true, and after a variant switch it
// still is — from the script being replaced. So nothing was uploaded and the
// device kept playing the old one, while the funscript engine, heatmap, badge,
// Buttplug and T-Code all updated correctly and made the switch LOOK like it
// had worked. His disconnect/reconnect workaround is just a longer way of
// clearing that flag, since `stop()` sets `_scriptReady = false`.
//
// Only the Autoblow was affected: the Handy block four lines above already
// does an explicit stop before re-uploading (with a comment describing exactly
// this failure), and Buttplug/T-Code re-read actions per tick so they have no
// upload to skip.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync('renderer/js/app.js', 'utf8');
const switchBody = src.slice(
  src.indexOf('async _switchVariant(index)'),
  src.indexOf('_updateVariantSelector()', src.indexOf('async _switchVariant(index)')),
);

describe('_switchVariant — Autoblow gets the new script', () => {
  it('stops the Autoblow sync before re-uploading', () => {
    expect(switchBody).toMatch(/this\.autoblowSync\.stop\(\)/);
  });

  it('stops BEFORE calling the upload helper, not after', () => {
    // Order is the whole fix. Stopping afterwards would clear the flag but
    // leave the skipped upload skipped, and the device on the old script.
    const stopAt = switchBody.indexOf('this.autoblowSync.stop()');
    const uploadAt = switchBody.indexOf('_tryStartAutoblowSync()');
    expect(stopAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(uploadAt);
  });

  it('only stops when an Autoblow is actually connected', () => {
    // Calling stop() unconditionally would fire syncStop() at a device that
    // is not there on every variant switch for every other user.
    expect(switchBody).toMatch(/this\.autoblowManager\?\.connected && this\.autoblowSync/);
  });

  it('still re-uploads to the Handy with its own explicit stop', () => {
    // The neighbouring path this one was modelled on — guard against a future
    // edit removing the pattern from the device that already had it right.
    expect(switchBody).toMatch(/this\.handyManager\?\.connected/);
    expect(switchBody).toMatch(/hsspStop\(\)/);
  });

  it('still reloads the per-tick engines, which need no upload', () => {
    expect(switchBody).toMatch(/buttplugSync\?\._active.*reloadActions\(\)/s);
    expect(switchBody).toMatch(/tcodeSync\?\._active.*reloadActions\(\)/s);
  });
});

describe('the flag that caused it', () => {
  const helper = src.slice(
    src.indexOf('async _tryStartAutoblowSync()'),
    src.indexOf('async _autoConnectHandy'),
  );

  it('_tryStartAutoblowSync still skips the upload when a script is ready', () => {
    // Documenting the short-circuit rather than removing it: it is correct
    // for its other callers (re-arming an already-loaded script), and the
    // variant path is the one that must clear the flag first.
    expect(helper).toMatch(/if \(!this\.autoblowSync\.scriptReady\)/);
  });
});

describe('AutoblowSync.stop clears the flag it needs to', () => {
  const syncSrc = fs.readFileSync('renderer/js/autoblow-sync.js', 'utf8');
  const stopBody = syncSrc.slice(syncSrc.indexOf('  stop()'), syncSrc.indexOf('async uploadScript'));

  it('resets scriptReady, so the next call really uploads', () => {
    expect(stopBody).toMatch(/this\._scriptReady = false/);
  });

  it('also tells the device to stop, so the swap lands on an idle device', () => {
    expect(stopBody).toMatch(/this\.autoblow\.syncStop\(\)/);
  });
});
