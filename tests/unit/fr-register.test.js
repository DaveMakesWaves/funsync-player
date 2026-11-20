/**
 * @vitest-environment node
 * No DOM required — reads the French bundle as data. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-26 (Dave's French read, carry-over B verifier 1): fr.json mixed "tu"
// and "vous", e.g. the Playback hints "Appuie sur G pour sauter
// manuellement" next to "…dont vous avez plusieurs copies…". The whole
// French UI says "vous" now (imperatives "Appuyez", "Cliquez"; "votre / vos";
// "Assurez-vous"). These are the words a French reader sees, so the check
// reads every value of the bundle: no tu pronoun or possessive, no
// imperative-with-toi, and none of the tu imperatives the file used to have.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const flat = {};
(function walk(o, p) {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') walk(v, key); else flat[key] = String(v);
  }
})(JSON.parse(fs.readFileSync('renderer/locales/fr.json', 'utf8')), '');

// Markup is not prose ("<strong>"); a value is checked as the user reads it.
const prose = (s) => s.replace(/<[^>]+>/g, ' ');
const hits = (re) => Object.entries(flat).filter(([, v]) => re.test(prose(v))).map(([k, v]) => `${k}: ${v}`);
const L = '\\p{L}';
const word = (alts) => new RegExp(`(^|[^${L}'’-])(${alts.join('|')})(?=[^${L}]|$)`, 'iu');

describe('French says "vous" everywhere (R3-26)', () => {
  it('no tu, te, toi, ton / ta / tes, tien(ne)(s)', () => {
    expect(hits(word(['tu', 'te', 't\'', 't’', 'toi', 'ton', 'ta', 'tes', 'tien', 'tiens', 'tienne', 'tiennes']))).toEqual([]);
  });

  it('no imperative with -toi ("Assure-toi", "reconnecte-toi", "Attends-toi")', () => {
    expect(hits(new RegExp(`[${L}]+-toi(?=[^${L}]|$)`, 'iu'))).toEqual([]);
  });

  it('none of the tu imperatives the file had', () => {
    // Clause-initial, so the same -er form used as a 3rd-person description
    // ("Affiche une carte…", "Compense le délai…") is not caught.
    const TU = ['Appuie', 'Clique', 'Saisis', 'Choisis', 'Sélectionne', 'Reconnecte', 'Connecte', 'Vérifie',
      'Essaie', 'Utilise', 'Colle', 'Ajoute', 'Ouvre', 'Crée', 'Renomme', 'Assigne', 'Scanne', 'Survole',
      'Maintiens', 'Relâche', 'Garde', 'Ajuste', 'Désactive-le', 'Récupère-la', 'Traite-les', 'choisis-en',
      'démarres-en', 'redémarre', 'Pilote', 'Configure',
      // Irregular verbs, whose tu imperative is not the -e form the list
      // above catches: "Va sur handyfeeling.com" survived the first pass
      // (R3-26 fix-up, real-app verifier 1).
      'Va', 'Vas-y', 'Fais', 'Mets', 'Prends', 'Lis', 'Dis', 'Attends', 'Reviens', 'Viens', 'Sois', 'Aie',
      'Sache', 'Veuille', 'Rends', 'Éteins', 'Ouvre-le', 'Souviens-toi'];
    const re = new RegExp(`(^|[.!?:;—–(]\\s*|,\\s+|\\b(?:puis|et|ou)\\s+)(${TU.join('|')})(?=[^${L}]|$)`, 'u');
    // The same spelling as a 3rd-person description, as in English.
    const THIRD_PERSON = new Set([
      'settingsPanel.appearance.cardHeatmapHint', // "Utilise le script principal" = "Uses the video's main script"
      'editor.everyNthResult', // "Sélectionne # points." = "Selects # points."
    ]);
    expect(hits(re).filter((h) => !THIRD_PERSON.has(h.split(': ')[0]))).toEqual([]);
  });

  it('the strings Dave quoted read in "vous" now', () => {
    expect(flat['settingsPanel.playback.gapHint']).toContain('Appuyez sur G pour sauter manuellement');
    expect(flat['settingsPanel.duplicates.sectionBlurb']).toContain('dont vous avez plusieurs copies');
    expect(flat['languagePrompt.title']).toBe('Choisissez votre langue');
    expect(flat['connection.handy.firmwareUpdate']).toContain('Rendez-vous sur handyfeeling.com');
  });
});
