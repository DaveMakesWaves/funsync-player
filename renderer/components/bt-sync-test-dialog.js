// Devices ▸ Buttplug ▸ Sync test… (brokenobj #431, 2026-11-23). The dialog
// for renderer/js/bt-sync-test.js: Measure the round trip through Intiface,
// then Feel it (the toy pulses with a flash on screen, a slider moves the
// pulse), then Save the offset (buttplug.defaultOffset, source 'user', live
// on the sync engine). The beat stops when the dialog closes, on Escape, and
// on Stop all (stopBtSyncTest, which app.stopEverything calls).

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { SyncPulser, summariseRoundTrips, clampOffset, pulseKind, OFFSET_MIN, OFFSET_MAX, OFFSET_STEP } from '../js/bt-sync-test.js';

let active = null; // the running pulser, for Stop all

/** Stop all: end a running sync test at once (its toys get their stop). */
export function stopBtSyncTest() {
  const was = active?.stop?.() === true;
  active = null;
  return was;
}

/**
 * @param {{ manager: object, settings: object, sync?: object, pausePlayback?: () => void }} opts
 * @returns {Promise<{ saved: boolean, offsetMs?: number } | null>}
 */
export function openBtSyncTestDialog({ manager, settings, sync, pausePlayback }) {
  pausePlayback?.();
  const devices = (manager?.devices || []).filter((d) => pulseKind(d));
  const start = clampOffset(settings?.get?.('buttplug.defaultOffset') || 0);
  let offset = start;
  let pulser = null;

  return Modal.open({
    title: t('connection.syncTest.title'),
    panelClass: 'bt-sync-test',
    onRender(body, close) {
      const p = (cls, text) => { const el = document.createElement('p'); el.className = cls; el.textContent = text; return el; };
      body.appendChild(p('bt-sync-test__intro', t('connection.syncTest.intro')));

      if (!manager?.connected || devices.length === 0) {
        body.appendChild(p('bt-sync-test__none', t('connection.syncTest.noDevices')));
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'modal-btn modal-btn--secondary';
        ok.textContent = t('common.close');
        ok.addEventListener('click', () => close(null));
        actions.appendChild(ok);
        body.appendChild(actions);
        return;
      }
      body.appendChild(p('bt-sync-test__devices', t('connection.syncTest.devices', { names: devices.map((d) => d.name).join(', ') })));

      // 1. Measure
      const m = document.createElement('section');
      m.className = 'bt-sync-test__step';
      const mHead = document.createElement('h3');
      mHead.className = 'bt-sync-test__step-title';
      mHead.textContent = t('connection.syncTest.measureTitle');
      const mRow = document.createElement('div');
      mRow.className = 'bt-sync-test__row';
      const measure = document.createElement('button');
      measure.type = 'button';
      measure.className = 'modal-btn modal-btn--secondary bt-sync-test__measure';
      measure.textContent = t('connection.syncTest.measure');
      const result = document.createElement('span');
      result.className = 'bt-sync-test__result';
      result.setAttribute('aria-live', 'polite');
      const useIt = document.createElement('button');
      useIt.type = 'button';
      useIt.className = 'modal-btn modal-btn--secondary bt-sync-test__use';
      useIt.hidden = true;
      mRow.append(measure, result, useIt);
      m.append(mHead, p('bt-sync-test__hint', t('connection.syncTest.measureHint')), mRow);
      body.appendChild(m);

      // 2. Feel it
      const f = document.createElement('section');
      f.className = 'bt-sync-test__step';
      const fHead = document.createElement('h3');
      fHead.className = 'bt-sync-test__step-title';
      fHead.textContent = t('connection.syncTest.feelTitle');
      const flash = document.createElement('div');
      flash.className = 'bt-sync-test__flash';
      flash.setAttribute('aria-hidden', 'true');
      const fRow = document.createElement('div');
      fRow.className = 'bt-sync-test__row';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'modal-btn modal-btn--secondary bt-sync-test__go';
      go.textContent = t('connection.syncTest.start');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'bt-sync-test__slider';
      slider.min = String(OFFSET_MIN); slider.max = String(OFFSET_MAX); slider.step = String(OFFSET_STEP);
      slider.value = String(offset);
      slider.setAttribute('aria-label', t('connection.syncTest.offsetAria'));
      const val = document.createElement('output');
      val.className = 'bt-sync-test__value';
      const paintVal = () => {
        val.textContent = offset === 0 ? t('connection.syncTest.offsetZero')
          : t(offset < 0 ? 'connection.syncTest.offsetEarlier' : 'connection.syncTest.offsetLater', { ms: Math.abs(offset) });
      };
      paintVal();
      fRow.append(go, slider, val);
      f.append(fHead, p('bt-sync-test__hint', t('connection.syncTest.feelHint')), flash, fRow);
      body.appendChild(f);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'modal-btn modal-btn--secondary';
      cancel.textContent = t('common.cancel');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'modal-btn modal-btn--primary bt-sync-test__save';
      save.textContent = t('connection.syncTest.save');
      actions.append(cancel, save);
      body.appendChild(actions);

      const setOffset = (ms) => {
        offset = clampOffset(ms);
        slider.value = String(offset);
        pulser?.setOffset(offset);
        paintVal();
      };
      slider.addEventListener('input', () => setOffset(slider.value));

      measure.addEventListener('click', async () => {
        measure.disabled = true;
        result.textContent = t('connection.syncTest.measuring');
        useIt.hidden = true;
        const wasRunning = pulser?.running;
        if (wasRunning) { pulser.stop(); go.textContent = t('connection.syncTest.start'); }
        let samples = [];
        try {
          for (const d of devices) samples = samples.concat(await manager.measureRoundTrip(d.index, { count: 10 }));
        } catch { samples = []; }
        const s = summariseRoundTrips(samples);
        measure.disabled = false;
        if (!s) { result.textContent = t('connection.syncTest.measureFailed'); return; }
        // Intiface answered before the toy had the command (a Lovense Edge:
        // 1-2 ms): not the Bluetooth delay, so nothing saved or suggested.
        if (!s.plausible) { result.textContent = t('connection.syncTest.measuredTooFast', { median: s.median }); return; }
        settings?.set?.('buttplug.measuredRoundTripMs', s.median);
        result.textContent = t('connection.syncTest.measured', { median: s.median, min: s.min, max: s.max });
        useIt.textContent = t('connection.syncTest.useSuggested', { ms: s.suggested });
        useIt.hidden = false;
        useIt.onclick = () => setOffset(s.suggested);
      });

      go.addEventListener('click', () => {
        if (pulser?.running) {
          pulser.stop();
          active = null;
          go.textContent = t('connection.syncTest.start');
          return;
        }
        pulser = new SyncPulser({
          manager,
          devices,
          onBeat: () => {
            flash.classList.remove('is-on');
            void flash.offsetWidth; // restart the flash
            flash.classList.add('is-on');
          },
          // Stopped from anywhere (Stop all too): the button says Start again.
          onStop: () => { go.textContent = t('connection.syncTest.start'); },
        });
        pulser.setOffset(offset);
        if (pulser.start()) {
          active = pulser;
          go.textContent = t('connection.syncTest.stop');
        }
      });

      const finish = (value) => {
        if (pulser) { pulser.stop(); if (active === pulser) active = null; }
        close(value);
      };
      cancel.addEventListener('click', () => finish(null));
      save.addEventListener('click', () => {
        settings?.set?.('buttplug.defaultOffset', offset);
        settings?.set?.('buttplug.defaultOffsetSource', 'user');
        sync?.setOffsetMs?.(offset);
        finish({ saved: true, offsetMs: offset });
      });
    },
  }).finally(() => {
    // Escape, the X or the backdrop: the beat stops too.
    if (pulser) { pulser.stop(); if (active === pulser) active = null; }
  });
}

/** Is a sync test's beat running (Stop all lists it only then)? */
export function isBtSyncTestRunning() {
  return !!active?.running;
}
