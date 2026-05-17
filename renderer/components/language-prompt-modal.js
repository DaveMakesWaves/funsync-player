// LanguagePromptModal — first-launch language picker.
//
// Surfaced when settings.player.languageSelected is falsy. Asks the user to
// confirm their language explicitly before the rest of the UI proceeds in
// (defaulted) English. The flag is set ONLY when the user picks a button —
// dismissing the modal (X / Esc / backdrop) leaves the flag falsy so the
// modal re-appears on the next launch.
//
// Why a modal and not the legacy offer-toast: existing 0.5.x users opening
// this build for the first time need to see the new languages on equal
// footing — the toast hid the choice behind a single accept/dismiss action
// in their OS locale only. A modal with all eight buttons in native script
// lets a non-English speaker pick their language without having to read
// English UI first (Nielsen #2 match between system and real world —
// "中文" / "한국어" / "Русский" are universally recognised by their own
// speakers regardless of UI language).

import { Modal } from './modal.js';
import { icon, Languages } from '../js/icons.js';
import { t, SUPPORTED_LOCALES, LOCALE_LABELS, setLocale, resolveLocale, translatePage } from '../js/i18n.js';

/**
 * Show the language-prompt modal. Resolves once closed.
 *
 * @param {Object} args
 * @param {import('../js/data-service.js').DataService} args.settings
 * @param {string} [args.systemLocale] — `app.getLocale()` value (highlighted as "Suggested" if non-English)
 * @returns {Promise<{ locale: string|null, accepted: boolean }>}
 *   - locale: the chosen locale, or null if dismissed
 *   - accepted: true if the user picked a language (flag should be persisted)
 */
export async function openLanguagePromptModal({ settings, systemLocale } = {}) {
  // Pre-resolve the OS-detected locale so we know which button to badge as
  // "Suggested". If the OS reports English (or any unsupported locale), no
  // button gets the badge — every option reads equally.
  const detected = systemLocale ? resolveLocale(systemLocale) : 'en';
  const showSuggested = detected !== 'en' && SUPPORTED_LOCALES.includes(detected);

  let chosen = null;

  await Modal.open({
    title: t('languagePrompt.title'),
    onRender: (body, close) => {
      const wrap = document.createElement('div');
      wrap.className = 'language-prompt';

      // Icon + bilingual subtitle. The English subtitle covers the default
      // case (no detected suggestion); the OS-detected subtitle appears
      // below it so a non-English speaker sees the prompt in their own
      // language without having to read English.
      const iconEl = icon(Languages, { width: 32, height: 32 });
      iconEl.classList.add('language-prompt__icon');
      wrap.appendChild(iconEl);

      const subtitleEn = document.createElement('p');
      subtitleEn.className = 'language-prompt__subtitle';
      subtitleEn.textContent = t('languagePrompt.subtitle');
      wrap.appendChild(subtitleEn);

      // Grid of language buttons. Native names so the user recognises their
      // own language regardless of current UI locale.
      const grid = document.createElement('div');
      grid.className = 'language-prompt__grid';

      for (const code of SUPPORTED_LOCALES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'language-prompt__btn';
        btn.dataset.locale = code;

        const label = document.createElement('span');
        label.className = 'language-prompt__btn-label';
        label.textContent = LOCALE_LABELS[code] || code;
        btn.appendChild(label);

        if (showSuggested && code === detected) {
          btn.classList.add('language-prompt__btn--suggested');
          const badge = document.createElement('span');
          badge.className = 'language-prompt__btn-badge';
          badge.textContent = t('languagePrompt.suggested');
          btn.appendChild(badge);
        }

        btn.addEventListener('click', async () => {
          chosen = code;
          try {
            await setLocale(code);
            // Re-translate any static data-i18n elements in the page so the
            // rest of the UI flips to the new language without a reload.
            translatePage(document);
            // Persist BOTH the language and the "user has chosen" flag so
            // the modal does not re-appear next launch.
            settings.set('player.language', code);
            settings.set('player.languageSelected', true);
          } catch (err) {
            console.warn('[LanguagePromptModal] setLocale failed:', err);
          }
          close({ locale: code });
        });

        grid.appendChild(btn);
      }

      wrap.appendChild(grid);

      const hint = document.createElement('p');
      hint.className = 'language-prompt__hint';
      hint.textContent = t('languagePrompt.hint');
      wrap.appendChild(hint);

      body.appendChild(wrap);

      // Auto-focus the suggested button if present, else the first button.
      // Keyboard users can press Enter to confirm the suggestion immediately.
      setTimeout(() => {
        const target = grid.querySelector('.language-prompt__btn--suggested')
          || grid.querySelector('.language-prompt__btn');
        target?.focus();
      }, 0);
    },
  });

  return { locale: chosen, accepted: chosen !== null };
}
