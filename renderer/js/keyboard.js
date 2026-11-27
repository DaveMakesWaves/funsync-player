// KeyboardHandler — Keyboard shortcuts for video playback

import { vrZoomStepFor } from './vr-zoom-keys.js';
import { openKeyboardHelp, getPlayerShortcutGroups } from './keyboard-help.js';
import { t } from './i18n.js';
import { layoutKey, digitKey } from './keyboard-layout.js';

// Controls that own EVERY key while focused: typing, picking an option,
// stepping a value. The handler used to exempt only INPUT and TEXTAREA, so
// ArrowDown on a focused Settings dropdown changed the volume instead, and
// the preventDefault stopped the dropdown changing at all (V43).
//
// An <input> is NOT in this list: most of them own every key (text, number,
// search, date...), but a slider, a checkbox or a button-like input owns
// only the few keys it uses. See inputOwnsKey (C-01).
const OWNS_ALL_KEYS = [
  'textarea', 'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
  '[role="listbox"]', '[role="spinbutton"]',
].join(', ');

// The keys a list marked data-owns-keys="navigation" uses (targetOwnsKey).
const LIST_NAV_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ',
]);

// The keys a native slider (<input type="range">) steps with. Every other key
// belongs to the player. The bare 'input' above used to give the focused
// volume slider EVERY key: after a drag or click on it, Space, K, M and F did
// nothing, the arrows moved the volume by 1 %, and F11 fell through to the
// View menu's window fullscreen, which the player does not know about.
// Fullscreen hides the bar, so the focus left on the slider was invisible:
// "the pause hotkey and other hotkeys dont work until i click the video"
// (C-01, Dave 2026-11-06; also in v0.9.2).
const RANGE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]);
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
// Inputs that Space / Enter activate like a button. They follow the <button>
// rule (ACTIVATES_ON_SPACE below): theirs only inside a modal dialog.
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image', 'color', 'file']);

/**
 * Does a focused <input> own this key? A slider owns its stepping keys, a
 * checkbox Space (and Enter), a radio those plus the arrows that move along
 * its group. Button-like inputs are handled with <button> (Space in a modal).
 * Anything typed into (text, number, search, date...) owns every key.
 */
function inputOwnsKey(input, key) {
  const type = String(input.type || 'text').toLowerCase();
  if (type === 'range') return RANGE_KEYS.has(key);
  if (type === 'checkbox') return key === ' ' || key === 'Enter';
  if (type === 'radio') return key === ' ' || key === 'Enter' || ARROW_KEYS.has(key);
  if (BUTTON_INPUT_TYPES.has(type)) return false;
  return true;
}

// Controls that Space activates. Only exempted inside a modal dialog: there,
// Space on "Got it" means close the help, not toggle the video behind the
// dialog. Outside one, Space keeps meaning play/pause after a mouse click
// left focus on a player control, as the play button's own "(Space)"
// tooltip promises.
const ACTIVATES_ON_SPACE = [
  'button', 'a[href]', 'summary',
  'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
  'input[type="image"]', 'input[type="color"]', 'input[type="file"]',
  '[role="button"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="tab"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
].join(', ');

// Keys that act on the player (play/pause, seek, volume, mute, fullscreen,
// screenshot, info, A-B loop and bookmarks, aspect / VR flatten, speed,
// chapters, gap skip, editor, variant, next / previous video). They act only
// while the user can SEE a player: the player view, the docked mini player,
// or the detached player window. After Back with the mini player off, Space
// in the Library played the hidden paused video (audio, no picture), and the
// arrows changed its volume instead of scrolling (CB-05). Elsewhere they do
// nothing and are not prevented, so Space reaches a focused control and the
// arrows scroll the page. Home / End have their own, stricter rule (V44).
const PLAYER_SURFACE_KEYS = new Set([
  ' ', 'k', 'K', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'j', 'J', 'l', 'L', 'm', 'M', 'f', 'F', 'F11', 's', 'S', 'i', 'I',
  'a', 'A', 'b', 'B', 'r', 'R', '<', '>', ',', '.', 'g', 'G',
  'e', 'E', 'v', 'V', 'n', 'N', 'p', 'P',
]);

/**
 * True when the key belongs to whatever has focus, not to the player.
 *
 * A control on the way here that already handled the key says so with
 * preventDefault: the progress slider's own arrows and Home/End, the
 * Settings rail's Up/Down, Enter/Space on a queue row, a toast or the
 * Up Next card. Acting on it again double-seeks, or changes the volume
 * while the rail moves. Escape is exempt: surfaces mark an Esc "taken" so
 * the layers under them (the queue panel, the A-B loop) stay as they are,
 * and the Esc case below has to see the press to know that (only the Up
 * Next card's dismiss runs before that check).
 *
 * Exported for the detached player window, which has its own key handler and
 * follows the same rule (E-01).
 */
/**
 * Is `el` a control of its own below a data-owns-keys="navigation" mark: an
 * <input>, something typed into, or a textarea / select / textbox-like role
 * that is not the marked list itself?
 */
function isControlBelow(el, mark) {
  if (el === mark) return false;
  if (String(el.tagName).toUpperCase() === 'INPUT' || el.isContentEditable) return true;
  const owner = el.closest(OWNS_ALL_KEYS);
  return !!owner && owner !== mark && mark.contains(owner);
}

export function targetOwnsKey(e) {
  if (e.defaultPrevented && e.key !== 'Escape') return true;
  const el = e.target;
  if (!el || typeof el.closest !== 'function') return false;
  // Inside a menu (the player's ⋮, its speed list…) the arrows, Home / End
  // and Enter / Space are the menu's: Left / Right seeked the video behind
  // the open ⋮ by 5 s, and Space on "Loop video" played the video instead of
  // ticking it (test day 2026-11-26, B098). Letters still reach the player.
  if (LIST_NAV_KEYS.has(e.key) && el.closest('[role="menu"]')) return true;
  // A list that says it uses only its navigation keys (the Fill drawer's
  // pattern list, where the focus lands when it opens) owns those; F, M, K
  // and the rest go on to the player (live verifier 2026-11-17).
  // A control INSIDE such a list (a text box, a checkbox, a select) keeps its
  // own rule below: typing "f" in a text box there must not toggle
  // fullscreen (found 2a-dialog 2026-11-18; latent, fixed 2026-11-22).
  const navMark = el.closest('[data-owns-keys="navigation"]');
  if (navMark && !isControlBelow(el, navMark)) return LIST_NAV_KEYS.has(e.key);
  // The marked list (often a role="listbox") or anything around it is not
  // what owns a control's keys there: the control is.
  const owner = el.closest(OWNS_ALL_KEYS);
  if (el.isContentEditable || (owner && !(navMark && owner.contains(navMark)))) return true;
  // A focused <input> owns only its own keys (C-01). An input never has
  // children, so the target itself is the one to ask. Inside a dialog it
  // owns every key, as every <input> did in v0.9.2: the C-01 rule let
  // Space, K and M through from a focused Settings or Devices slider, and
  // the video behind the dialog paused, played or muted (block C
  // verifier 1). C-01 is about the player bar's slider, never in a dialog.
  if (String(el.tagName).toUpperCase() === 'INPUT'
      && (el.closest('[aria-modal="true"]') || inputOwnsKey(el, e.key))) return true;
  if (e.key === ' ' && el.closest('[aria-modal="true"]') && el.closest(ACTIVATES_ON_SPACE)) return true;
  return false;
}

export class KeyboardHandler {
  constructor({ videoPlayer, connectionPanel, onOpenFile, scriptEditor, deviceSimulator, gapSkipEngine, onNavigate, onToggleLoop, onToggleQueue, isQueueOpen, onJumpChapter, onJumpBookmark, onLoadNext, onLoadPrev, onPlaybackCommand, isVRZoomActive, getVRZoomKeys, getView, hasOffViewPlayer }) {
    this.player = videoPlayer;
    // () => the VR zoom keys in use (vr-zoom-keys.js readVRZoomKeys): zoom
    // with no Ctrl while isVRZoomActive (Buck Nakkidd, Discord 2026-11-27).
    // Unset means only the Ctrl keys zoom.
    this.getVRZoomKeys = getVRZoomKeys || null;
    // () => boolean: is a VR video open in the player view? Only then do
    // Ctrl+= / Ctrl+- / Ctrl+0 mean VR zoom. Otherwise they are left to the
    // View menu's whole-interface zoom, which they swallowed everywhere in
    // v0.9.2 (V45). Unset means never VR zoom.
    this.isVRZoomActive = isVRZoomActive || null;
    // () => the current view id ('library', 'player', ...). Keys that only
    // make sense on the player (Home/End) give way to the page elsewhere,
    // so End scrolls the Library to its last row (V44). Unset means the
    // player, the handler's original assumption.
    this.getView = getView || null;
    // () => boolean: is a player on screen OUTSIDE the player view (the
    // docked mini player, or the detached player window)? With getView it
    // decides whether the playback keys act (PLAYER_SURFACE_KEYS, CB-05).
    this.hasOffViewPlayer = hasOffViewPlayer || null;
    // Optional: send a playback command somewhere other than the inline
    // player. While the detached player window owns playback, the inline
    // <video> is paused and hidden, so Space or an arrow here used to start
    // or seek a second, invisible copy while the pop-out and the device
    // carried on (V13). (command, arg) => true when it handled the command;
    // anything else falls through to the inline player as before.
    this.onPlaybackCommand = onPlaybackCommand || null;
    this.connectionPanel = connectionPanel || null;
    this.onOpenFile = onOpenFile || null;
    this.scriptEditor = scriptEditor || null;
    this.deviceSimulator = deviceSimulator || null;
    this.gapSkipEngine = gapSkipEngine || null;
    this.onNavigate = onNavigate || null;
    this.onToggleLoop = onToggleLoop || null;
    this.onToggleQueue = onToggleQueue || null;
    // () => boolean: is the queue panel open? Lets Esc close it (V26).
    this.isQueueOpen = isQueueOpen || null;
    this.onJumpChapter = onJumpChapter || null;
    this.onJumpBookmark = onJumpBookmark || null;
    this.onLoadNext = onLoadNext || null;
    this.onLoadPrev = onLoadPrev || null;
    this._bindEvents();
  }

  /** True when onPlaybackCommand took this command (see the constructor). */
  _routePlayback(command, arg) {
    return !!this.onPlaybackCommand && this.onPlaybackCommand(command, arg) === true;
  }

  /** True on the player view, or when no view accessor was wired. */
  _inPlayerView() {
    return !this.getView || this.getView() === 'player';
  }

  /** True while the user can see a player: the player view, the mini player or the pop-out (CB-05). */
  _playerSurfaceVisible() {
    return this._inPlayerView() || !!this.hasOffViewPlayer?.();
  }

  /**
   * The View menu's F11, which main sends only for an F11 the page did not
   * take (a text field focused in the player view, any other view): the
   * player's fullscreen, as F11 on the page is, never the window's (Dave
   * 2026-11-22). Leaving the player's fullscreen always works; with no
   * player on screen nothing happens. True when it acted.
   */
  toggleFullscreenFromMenu() {
    if (!document.fullscreenElement && !this._playerSurfaceVisible()) return false;
    this.player.toggleFullscreen();
    return true;
  }

  _bindEvents() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => this._onKeyUp(e));
  }

  /**
   * Key-up handler — the two hold keys (Orgasm Switch X, Edge Hold Z).
   * Deliberately does NOT gate on focus/editor: if a hold was started we
   * must always release it, even if focus moved to an input mid-hold
   * (otherwise the device would be stuck driving the orgasm loop, or — for
   * Edge — stuck silent). The holds themselves are gated in _onKeyDown.
   */
  _onKeyUp(e) {
    // The same layoutKey as the keydown below (FT-035): on a Russian layout
    // X types 'ч', and a hold started by layoutKey must end on the same key,
    // or the device stays on the orgasm loop (or silent) after release.
    const key = layoutKey(e);
    if ((key === 'x' || key === 'X') && this._orgasmHoldActive) {
      this._orgasmHoldActive = false;
      if (this.onOrgasmHold) this.onOrgasmHold(false);
    }
    if ((key === 'z' || key === 'Z') && this._edgeHoldActive) {
      this._edgeHoldActive = false;
      if (this.onEdgeHold) this.onEdgeHold(false);
    }
  }

  _onKeyDown(e) {
    // Keys belong to a focused text field, dropdown or list, or to whatever
    // control already handled them (V43). See targetOwnsKey.
    if (targetOwnsKey(e)) return;

    // Shift+Space: Stop all (DESIGN.md §1.6 S1, §2.15), in EVERY view, so
    // before the player-surface gate below. After targetOwnsKey: a focused
    // text field keeps it (Shift held while typing a space must type it).
    if (e.key === ' ' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && this.onStopAll) {
      e.preventDefault();
      if (!e.repeat) this.onStopAll();
      return;
    }

    // Alt+1/2/3 — top-level nav between Library / Playlists / Categories.
    // Slack/Discord/Notion convention; Nielsen #7 (flexibility for experts).
    // Skipped when the editor canvas owns input or a modal is on screen
    // (modals trap focus on themselves so the typical guard is a no-op,
    // but the editor handles its own keys without focusing — gate
    // explicitly).
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && this.onNavigate && !this.scriptEditor?.isOpen) {
      const navMap = { '1': 'library', '2': 'playlists', '3': 'categories' };
      // On the number-row KEY, not e.key: AZERTY types & é " there (CB-06).
      const target = navMap[digitKey(e)];
      if (target) {
        e.preventDefault();
        this.onNavigate(target);
        return;
      }
    }

    // Ctrl+= / Ctrl+- / Ctrl+0 zoom the VR video, mirroring Ctrl+scroll and
    // trackpad pinch for anyone without a wheel. '+' is included since
    // Shift+= is how many layouts produce it.
    //
    // ONLY while a VR video is open in the player (isVRZoomActive). The
    // same keys are the View menu's whole-interface zoom (main.js
    // buildAppMenu), and Electron fires a menu accelerator only for a key
    // the page did NOT preventDefault. v0.9.2 took them unconditionally,
    // so interface zoom died in every view and on every flat video while
    // the VR handler did nothing (V45, forum #372). With a VR video open,
    // preventDefault MUST run, or the interface zooms along with the video.
    //
    // Gated on the editor being closed, matching every other player-only
    // key here. The editor binds BARE +/=/- to its own timeline zoom and
    // calls stopPropagation, so a focused canvas already wins — but with
    // the editor open and focus elsewhere this would otherwise zoom the
    // video behind the editor, which is not what the user is looking at.
    if (e.ctrlKey && !e.altKey && !this.scriptEditor?.isOpen && this.isVRZoomActive?.()) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        if (this.onVRZoom) this.onVRZoom(1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        if (this.onVRZoom) this.onVRZoom(-1);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        if (this.onVRZoomReset) this.onVRZoomReset();
        return;
      }
    }

    // The same zoom on one key, no Ctrl (Buck Nakkidd, Discord 2026-11-27:
    // "sucks having to let go of device just to zoom"): bare = / - by default,
    // set in Settings > Keyboard, and the numpad's + / -. Same gate as the
    // Ctrl keys above; they are matched first, so Ctrl+= stays theirs.
    if (this.getVRZoomKeys && !this.scriptEditor?.isOpen && this.isVRZoomActive?.()) {
      const step = vrZoomStepFor(e, this.getVRZoomKeys());
      if (step) {
        e.preventDefault();
        if (this.onVRZoom) this.onVRZoom(step);
        return;
      }
    }

    // layoutKey: the Latin letter on the key when the layout types another
    // alphabet (Russian а on F, т on N), so the letter cases below work there
    // too (FT-035). Every other key is e.key unchanged.
    const key = layoutKey(e);
    // No player on screen: the playback keys are not ours (CB-05).
    if (PLAYER_SURFACE_KEYS.has(key) && !this._playerSurfaceVisible()) return;
    switch (key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        if (!this._routePlayback('toggle')) this.player.togglePlay();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        // Shift+Arrow pans the VR projection ±10° when a spherical
        // projection is active; otherwise the arrow seeks 5s.
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(-10, 0);
        } else if (!this._routePlayback('seekBy', -5)) {
          this.player.skip(-5);
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(10, 0);
        } else if (!this._routePlayback('seekBy', 5)) {
          this.player.skip(5);
        }
        break;

      case 'j':
      case 'J':
        e.preventDefault();
        if (!this._routePlayback('seekBy', -10)) this.player.skip(-10);
        break;

      case 'l':
      case 'L':
        e.preventDefault();
        // Shift+L toggles video loop; plain l/L seeks forward 10s.
        // The case catches both shifted-and-unshifted because some
        // keyboard layouts emit either depending on caps-lock; the
        // shiftKey check is the source of truth.
        if (e.shiftKey && this.onToggleLoop) {
          this.onToggleLoop();
        } else if (!this._routePlayback('seekBy', 10)) {
          this.player.skip(10);
        }
        break;

      case 'q':
      case 'Q':
        // Shift+Q toggles the queue panel. Plain Q is taken by the
        // editor's alternating-insert binding and is only meaningful
        // when the editor canvas has focus.
        if (e.shiftKey && this.onToggleQueue) {
          e.preventDefault();
          this.onToggleQueue();
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(0, -10); // pitch up (look up)
        } else if (!this._routePlayback('volumeBy', 0.05)) {
          this.player.setVolume(this.player.video.volume + 0.05);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey && this.onVRPan && this.player.isVRProjecting) {
          this.onVRPan(0, 10); // pitch down (look down)
        } else if (!this._routePlayback('volumeBy', -0.05)) {
          this.player.setVolume(this.player.video.volume - 0.05);
        }
        break;

      // Home / End — jump to the start or end of the video.
      //
      // These were listed in the `?` help from the beginning but never
      // actually implemented in the player: pressing them did nothing.
      // Found by the shortcut audit on 2026-08-15. The editor binds both
      // to its own actions (repeat-last-stroke / move-to-playhead), so
      // they are gated like every other player-only key.
      //
      // Player view only. Elsewhere they are the page's own keys: End
      // scrolls the Library to its last row. They used to be swallowed in
      // every view, and with the mini-player docked they silently seeked
      // the corner video instead (V44). The one exception is the detached
      // player window: while it owns playback the main window sits on the
      // Library, and every playback key there drives the pop-out (V13),
      // so _routePlayback runs before the view check.
      case 'Home':
        if (this.scriptEditor?.isOpen) break;
        if (this._routePlayback('seekTo', 0)) { e.preventDefault(); break; }
        if (!this._inPlayerView()) break;
        e.preventDefault();
        this.player.seek(0);
        break;

      case 'End':
        if (this.scriptEditor?.isOpen) break;
        if (this._routePlayback('seekToEnd')) { e.preventDefault(); break; }
        if (!this._inPlayerView()) break;
        e.preventDefault();
        // Land a hair before the end: seeking exactly to `duration` fires
        // `ended` on some builds, which would advance the playlist instead
        // of showing the last frame.
        if (Number.isFinite(this.player.duration) && this.player.duration > 0) {
          this.player.seek(Math.max(0, this.player.duration - 0.05));
        }
        break;

      case 'm':
      case 'M':
        e.preventDefault();
        if (!this._routePlayback('toggleMute')) this.player.toggleMute();
        break;

      case 'f':
      case 'F':
        e.preventDefault();
        this.player.toggleFullscreen();
        break;

      case 'F11':
        e.preventDefault();
        this.player.toggleFullscreen();
        break;

      case 'h':
      case 'H':
        e.preventDefault();
        if (this.connectionPanel) {
          this.connectionPanel.toggle();
        }
        break;

      case 's':
      case 'S':
        e.preventDefault();
        this.player.captureScreenshot();
        break;

      case 'i':
      case 'I':
        e.preventDefault();
        this.player.toggleInfoOverlay();
        break;

      case 'a':
      case 'A':
        e.preventDefault();
        this.player.setLoopPoint('a');
        break;

      case 'b':
      case 'B':
        // Shift+B / Ctrl+B → bookmark prev/next (player-side bindings,
        // mirrors editor convention). Editor intercepts these when open,
        // so the guard below keeps player nav out of the way during
        // script authoring. Bare B is the A-B loop B-point.
        if (this.scriptEditor?.isOpen) {
          // Editor handles its own bookmark nav; let it through.
          break;
        }
        if (e.shiftKey && this.onJumpBookmark) {
          e.preventDefault();
          this.onJumpBookmark(-1);
        } else if ((e.ctrlKey || e.metaKey) && this.onJumpBookmark) {
          e.preventDefault();
          this.onJumpBookmark(+1);
        } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.player.setLoopPoint('b');
        }
        break;

      case 'r':
        // Ctrl+R (Cmd+R) is View > Reload, which asks about unsaved editor
        // edits first (R3-19). Taken here, it cycled the aspect ratio and the
        // reload never came in the player view (R3 fix-up, verifier 1, also
        // in v0.9.2). Ctrl+Shift+R (Force Reload) below likewise.
        if (e.ctrlKey || e.metaKey) break;
        e.preventDefault();
        this.player.cycleAspectRatio();
        break;

      case 'R':
        if (e.ctrlKey || e.metaKey) break;
        // Shift+R cycles the VR-as-flat playback mode (Off → Left → Right → Off).
        // Format is taken from the current video's stereo classification
        // — fed in by app.js after loadVideo runs. No-op if no format set.
        //
        // Ctrl+Shift+R used to open the VR Format panel here. Removed
        // 2026-08-14: zoom is now direct manipulation (Ctrl+scroll, trackpad
        // pinch, Ctrl+= / Ctrl+-), so the panel no longer needs a hotkey of
        // its own. It is still reachable from the player overflow menu and
        // the library kebab, both of which stay in sync with the gesture.
        e.preventDefault();
        if (this.onCycleVRFlatten) {
          this.onCycleVRFlatten();
        } else {
          this.player.cycleAspectRatio();
        }
        break;

      case '<':
      case ',':
        // Shift+, decrements playback speed (YouTube convention).
        // `,` arrives without Shift on US/UK layouts; `<` is what
        // some browsers report with Shift held. Accept both.
        // Bare `,` (no modifier) jumps to the previous chapter — the
        // editor's `,` is for selection and only fires when the editor
        // canvas has focus, so the guard below stays out of the way.
        if (e.shiftKey || e.key === '<') {
          e.preventDefault();
          if (!this._routePlayback('rate', -1)) this.player.cyclePlaybackRate(-1);
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey && !this.scriptEditor?.isOpen && this.onJumpChapter) {
          e.preventDefault();
          this.onJumpChapter(-1);
        }
        break;

      case '>':
      case '.':
        // Shift+. increments playback speed.
        // Bare `.` jumps to the next chapter — same guard as `,` above.
        if (e.shiftKey || e.key === '>') {
          e.preventDefault();
          if (!this._routePlayback('rate', +1)) this.player.cyclePlaybackRate(+1);
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey && !this.scriptEditor?.isOpen && this.onJumpChapter) {
          e.preventDefault();
          this.onJumpChapter(+1);
        }
        break;

      case 'd':
      case 'D':
        e.preventDefault();
        if (this.deviceSimulator) this.deviceSimulator.toggle();
        break;

      case 'e':
      case 'E':
        e.preventDefault();
        if (this.scriptEditor) this.scriptEditor.toggle();
        break;

      case 'v':
      case 'V':
        // Gated against the editor, like N: the editor follows the loaded
        // script, so a variant switch swaps the script out from under an
        // authoring session and drops its unsaved edits. The canvas already
        // stops V; this covers focus on an editor toolbar button, which used
        // to cycle the variant (found in the 2026-11-04 live check). The
        // variant dropdown still works.
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (this.onCycleVariant) this.onCycleVariant(key === 'V' ? -1 : 1);
        break;

      case 'g':
        e.preventDefault();
        // Mid-movement: the next movement; nothing ahead: says so (#442).
        if (this.gapSkipEngine) this.gapSkipEngine.skipNextFromKey();
        break;

      case 'G':
        e.preventDefault();
        if (this.gapSkipEngine) this.gapSkipEngine.skipToPreviousAction();
        break;

      case 'n':
      case 'N':
        // Next / previous video in the active queue. Same bindings the
        // detached pop-out window has always used, so the two windows
        // behave identically. Gated against the editor: swapping the
        // loaded video out from under an authoring session is worse
        // than a dead keypress. No-op with no queue, matching the
        // prev/next buttons (which stay hidden below 2 items).
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (this.onLoadNext) this.onLoadNext();
        break;

      case 'p':
      case 'P':
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (this.onLoadPrev) this.onLoadPrev();
        break;

      case 'o':
      case 'O':
        e.preventDefault();
        if (this.onOpenFile) this.onOpenFile();
        break;

      case 'x':
      case 'X':
        // Orgasm Switch — HOLD to swap the device(s) onto a short, looping
        // "orgasm" script; release to snap back to the main script (handled
        // in _onKeyUp). Gated against the editor so it doesn't fire during
        // authoring. keydown auto-repeats while held, so the _orgasmHoldActive
        // flag makes activation fire exactly once per physical press.
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (!this._orgasmHoldActive) {
          this._orgasmHoldActive = true;
          if (this.onOrgasmHold) this.onOrgasmHold(true);
        }
        break;

      case 'z':
      case 'Z':
        // Edge Hold — the Orgasm Switch's inverse, on the neighboring key:
        // HOLD to stop all device output while the video keeps playing;
        // release resumes the main script in sync at the current position
        // (handled in _onKeyUp). Same auto-repeat guard and editor gate as X.
        // (MattWritesNSFW, EroScripts #301.)
        if (this.scriptEditor?.isOpen) break;
        e.preventDefault();
        if (!this._edgeHoldActive) {
          this._edgeHoldActive = true;
          if (this.onEdgeHold) this.onEdgeHold(true);
        }
        break;

      case 'Escape':
        // Up Next dismiss runs FIRST so a visible card can be cleared
        // without also clearing the user's A-B loop. Other Esc handlers
        // only run when the card isn't showing. Not when a surface on top
        // already took this press (a playlist's Select mode, a panel): one
        // Esc both left Select mode and dismissed the card (block E2 review).
        // And only while its card can be seen (the player view, the mini
        // player or the pop-out): one armed in a player hidden behind a
        // playlist took the first Esc there, which looked like nothing, and
        // the queue panel needed a second (FT-104 re-check; fixed 2026-11-22).
        if (this.upNextEngine?.visible && !e.defaultPrevented && this._playerSurfaceVisible()) {
          e.preventDefault();
          this.upNextEngine.dismiss();
          break;
        }
        // An open queue panel is the next layer down: Esc closes it and
        // stops there, so the A-B loop survives that press (SCOPE-queue-panel
        // Q-E22). It used to have no Esc at all, in any view (V26).
        // Not when a surface on top already took this press (it called
        // preventDefault): Esc that closes the device panel, the overflow
        // menu or the speed popover must not close the queue under it too.
        if (!e.defaultPrevented && this.isQueueOpen?.() && this.onToggleQueue) {
          e.preventDefault();
          this.onToggleQueue();
          break;
        }
        // A surface on top took this press and closed itself: that is the
        // whole press. Without this the same Esc that closed the overflow
        // menu, the speed popover or the device panel also cleared the A-B
        // loop (FT-072; also in v0.9.2). The next Esc clears it.
        if (e.defaultPrevented) break;
        e.preventDefault();
        if (this.scriptEditor?.isOpen) {
          this.scriptEditor.hide();
        }
        this.player.clearAbLoop();
        if (this.connectionPanel) {
          this.connectionPanel.hide();
        }
        break;

      // ? opens the keyboard-shortcut help overlay (Nielsen #7 +
      // #10 — make every shortcut discoverable from one binding).
      // Skipped when the editor is open — its own canvas-level
      // handler picks `?` up there and renders the editor-specific
      // group set.
      case '?':
        if (!this.scriptEditor?.isOpen) {
          e.preventDefault();
          openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups({ vrZoomKeys: this.getVRZoomKeys?.() }));
        }
        break;

      default:
        break;
    }
  }
}
