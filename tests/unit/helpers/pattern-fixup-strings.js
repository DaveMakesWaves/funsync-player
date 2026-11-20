// The new strings of pf-fixup (2026-11-19), in the 8 locales, for the tests
// to render with until the merge step adds them to renderer/locales/*.json
// (SCRATCH/pf-fixup/strings.json is built from this file). Once merged,
// `withPatternFixupStrings` changes nothing: the values are the same.

export const PATTERN_FIXUP_STRINGS = {
  // PF-R2: the preview's stats line for square's / sawtooth's instant jumps in X and Z.
  'settingsPanel.patternBlock.statsWithInstant': {
    en: 'Average {avg} units/s, peak {max} units/s, plus instant jumps',
    de: 'Durchschnitt {avg} Einheiten/s, Spitze {max} Einheiten/s, dazu sofortige Sprünge',
    es: 'Media {avg} unidades/s, pico {max} unidades/s, más saltos instantáneos',
    fr: 'Moyenne {avg} unités/s, pic {max} unités/s, plus des sauts instantanés',
    ja: '平均 {avg} ユニット/秒、最大 {max} ユニット/秒、瞬間ジャンプあり',
    ko: '평균 {avg} 단위/초, 최대 {max} 단위/초, 순간 점프 포함',
    ru: 'Среднее {avg} ед/с, пик {max} ед/с, плюс мгновенные скачки',
    zh: '平均 {avg} 单位/秒，峰值 {max} 单位/秒，另有瞬间跳变',
  },
  'settingsPanel.patternBlock.statsInstantOnly': {
    en: 'Instant jumps, as fast as the device can move',
    de: 'Sofortige Sprünge, so schnell, wie das Gerät kann',
    es: 'Saltos instantáneos, tan rápido como pueda moverse el dispositivo',
    fr: "Sauts instantanés, aussi vite que l'appareil peut bouger",
    ja: '瞬間ジャンプ（デバイスの最高速度で動きます）',
    ko: '순간 점프, 기기가 움직일 수 있는 가장 빠른 속도',
    ru: 'Мгновенные скачки, так быстро, как может двигаться устройство',
    zh: '瞬间跳变，以设备能达到的最快速度移动',
  },
  // Dave's answers (2026-11-19 ~15:05): Gap Filler gets its own rail entry
  // (Edge Hold's uses its existing header, settingsPanel.playback.edgeHeader).
  // No new string: the rail reads settingsPanel.playback.fillerHeader.
  //
  // Item 4: Test plays on the Handy too; when the Handy cannot play it.
  'toast.patternTestHandyFailed': {
    en: 'The Handy could not play the test. Check its connection and try again.',
    de: 'Das Handy konnte den Test nicht abspielen. Prüfe die Verbindung und versuche es noch einmal.',
    es: 'El Handy no pudo reproducir la prueba. Comprueba la conexión y vuelve a intentarlo.',
    fr: "Le Handy n'a pas pu jouer le test. Vérifiez sa connexion et réessayez.",
    ja: 'Handy でテストを再生できませんでした。接続を確認して、もう一度お試しください。',
    ko: 'Handy에서 테스트를 재생하지 못했습니다. 연결을 확인하고 다시 시도하세요.',
    ru: 'Handy не смог проиграть тест. Проверьте подключение и попробуйте ещё раз.',
    zh: 'Handy 无法播放测试。请检查连接后重试。',
  },
};

export const PATTERN_FIXUP_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];

/** A locale bundle with the pf-fixup strings added where it has none (a copy). */
export function withPatternFixupStrings(bundle, locale) {
  const out = JSON.parse(JSON.stringify(bundle || {}));
  for (const [key, byLocale] of Object.entries(PATTERN_FIXUP_STRINGS)) {
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
    const leaf = parts[parts.length - 1];
    if (node[leaf] === undefined) node[leaf] = byLocale[locale] ?? byLocale.en;
  }
  return out;
}
