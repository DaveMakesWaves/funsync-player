/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL resume question is a REAL Modal, and the test
 * clicks its buttons and presses Escape (notes/CLAUDE.md "Test environments").
 */
// v0.10.1, found recording the EroScripts OP clips (2026-11-20): a playlist's
// Continue asked "Continue watching? You stopped at 7:05", and Resume opened
// the player at 7:05 PAUSED when Settings > Playback > Autoplay on open was off
// (the default). Dave, 2026-11-21: "Only Resume plays": the Resume click is the
// "play this"; Start over, and a dismissed question, still load paused.
//
// This file: the REAL `_maybeOfferResume` (lifted from app.js) with the REAL
// Modal: which answer each way out of the question gives. What the load does
// with that answer (the video and the Handy start at the resume position) is
// in playlist-resume-first-play.test.js, "Resume plays with Autoplay on open off".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { Modal } = await import('../../renderer/components/modal.js');
const { shouldOfferResume, formatResumeTime } = await import('../../renderer/js/resume-position.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const Lifted = liftAppClass(['_maybeOfferResume'], { Modal, t, shouldOfferResume, formatResumeTime });

const VIDEO = 'C:\\Lib\\Long Clip.mp4';
const AT = 425; // 7:05

let app;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  app = Object.assign(new Lifted(), {
    getResumeEntry: (p) => (p === VIDEO ? { position: AT, updatedAt: Date.now() } : null),
  });
});
afterEach(() => { document.body.innerHTML = ''; });

/** Ask, wait for the question, do `act` with its buttons, and return what the load gets. */
async function ask(act) {
  const answer = { play: false };
  const asked = app._maybeOfferResume(VIDEO, 1800, answer);
  await vi.waitFor(() => expect(document.querySelector('.modal-actions')).toBeTruthy());
  const [startOver, resume] = document.querySelectorAll('.modal-actions .modal-btn');
  expect(resume.textContent).toBe('Resume from 7:05');
  expect(startOver.textContent).toBe(EN.resume.startOver);
  act({ startOver, resume });
  return { at: await asked, play: answer.play };
}

describe('the resume question: only the Resume click plays (v0.10.1)', () => {
  it('Resume: the position, and play', async () => {
    expect(await ask(({ resume }) => resume.click())).toEqual({ at: AT, play: true });
  });

  it('Start over: no position, paused (unchanged)', async () => {
    expect(await ask(({ startOver }) => startOver.click())).toEqual({ at: null, play: false });
  });

  it('Escape: the position is kept, but nothing plays', async () => {
    const got = await ask(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(got).toEqual({ at: AT, play: false });
  });

  it('the dialog\'s X: the position is kept, but nothing plays', async () => {
    expect(await ask(() => document.querySelector('.modal-close-btn').click())).toEqual({ at: AT, play: false });
  });

  it('a caller that passes no answer object still gets the position (Resume)', async () => {
    const asked = app._maybeOfferResume(VIDEO, 1800);
    await vi.waitFor(() => expect(document.querySelector('.modal-actions')).toBeTruthy());
    document.querySelectorAll('.modal-actions .modal-btn')[1].click();
    expect(await asked).toBe(AT);
  });
});
