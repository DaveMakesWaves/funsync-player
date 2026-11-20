// The new strings of the shared Pattern block (pf-ui, 2026-11-19), in the 8
// locales, for the tests to render with until the merge step adds them to
// renderer/locales/*.json (SCRATCH/pf-ui/strings.json is built from this
// file). Once merged, `withPatternBlockStrings` changes nothing: the values
// are the same.

export const PATTERN_BLOCK_STRINGS = {
  'settingsPanel.patternBlock.quickPicks': {
    en: 'Quick picks', de: 'Schnellauswahl', es: 'Ajustes rápidos', fr: 'Choix rapides',
    ja: 'クイック選択', ko: '빠른 선택', ru: 'Быстрый выбор', zh: '快速选择',
  },
  'settingsPanel.patternBlock.preview': {
    en: 'Preview', de: 'Vorschau', es: 'Vista previa', fr: 'Aperçu',
    ja: 'プレビュー', ko: '미리보기', ru: 'Предпросмотр', zh: '预览',
  },
  'settingsPanel.patternBlock.previewAria': {
    en: 'Preview of the pattern as it will play, 8 seconds',
    de: 'Vorschau des Musters, wie es gespielt wird, 8 Sekunden',
    es: 'Vista previa del patrón tal como se reproducirá, 8 segundos',
    fr: "Aperçu du motif tel qu'il sera joué, 8 secondes",
    ja: '再生されるパターンのプレビュー（8秒）',
    ko: '재생될 패턴 미리보기, 8초',
    ru: 'Предпросмотр паттерна в том виде, в каком он будет играть, 8 секунд',
    zh: '将要播放的模式预览，8 秒',
  },
  'settingsPanel.patternBlock.rangeExact': {
    en: 'Exact', de: 'Genau', es: 'Exacto', fr: 'Exacte',
    ja: '数値で指定', ko: '직접 지정', ru: 'Точный', zh: '精确',
  },
  'settingsPanel.patternBlock.rangeScript': {
    en: 'Follow the script', de: 'Dem Skript folgen', es: 'Seguir el script', fr: 'Suivre le script',
    ja: 'スクリプトに合わせる', ko: '스크립트 따르기', ru: 'Следовать скрипту', zh: '跟随脚本',
  },
  'settingsPanel.patternBlock.depthValue': {
    en: '{pct}%', de: '{pct} %', es: '{pct} %', fr: '{pct} %',
    ja: '{pct}%', ko: '{pct}%', ru: '{pct} %', zh: '{pct}%',
  },
  'settingsPanel.patternBlock.centre': {
    en: 'Centre', de: 'Mitte', es: 'Centro', fr: 'Centre',
    ja: '中心', ko: '중심', ru: 'Центр', zh: '中心',
  },
  'settingsPanel.patternBlock.centreOwn': {
    en: "Script's own", de: 'Wie das Skript', es: 'El del script', fr: 'Celui du script',
    ja: 'スクリプトどおり', ko: '스크립트 기준', ru: 'Как в скрипте', zh: '脚本自身',
  },
  'settingsPanel.patternBlock.centreReset': {
    en: "Back to the script's own centre",
    de: 'Zurück zur Mitte des Skripts',
    es: 'Volver al centro propio del script',
    fr: 'Revenir au centre propre au script',
    ja: 'スクリプト本来の中心に戻す',
    ko: '스크립트 고유 중심으로 되돌리기',
    ru: 'Вернуть центр скрипта',
    zh: '恢复脚本自身的中心',
  },
  'settingsPanel.patternBlock.rangeScriptHint': {
    en: "Depth: how much of the script's own range the pattern uses, around where it plays. Centre: where in that range it sits.",
    de: 'Tiefe: wie viel vom eigenen Bereich des Skripts das Muster nutzt, rund um die Stelle, an der es spielt. Mitte: wo es in diesem Bereich liegt.',
    es: 'Profundidad: cuánto del rango propio del script usa el patrón, alrededor de donde se reproduce. Centro: dónde se sitúa dentro de ese rango.',
    fr: "Profondeur : la part de la plage propre au script qu'utilise le motif, autour de l'endroit où il est joué. Centre : sa place dans cette plage.",
    ja: '深さ：パターンが再生される位置の周辺で、スクリプト本来の範囲のどれだけを使うか。中心：その範囲のどこに置くか。',
    ko: '깊이: 패턴이 재생되는 지점 주변에서 스크립트 고유 범위를 얼마나 쓸지. 중심: 그 범위 안의 위치.',
    ru: 'Глубина: какую часть собственного диапазона скрипта использует паттерн там, где он играет. Центр: где в этом диапазоне он находится.',
    zh: '深度：模式在播放位置附近使用脚本自身范围的多少。中心：它在该范围中的位置。',
  },
  'settingsPanel.patternBlock.testHint': {
    en: 'Plays the preview on your connected devices',
    de: 'Spielt die Vorschau auf deinen verbundenen Geräten ab',
    es: 'Reproduce la vista previa en tus dispositivos conectados',
    fr: "Joue l'aperçu sur vos appareils connectés",
    ja: '接続中のデバイスでプレビューを再生します',
    ko: '연결된 기기에서 미리보기를 재생합니다',
    ru: 'Проигрывает предпросмотр на подключённых устройствах',
    zh: '在已连接的设备上播放预览',
  },
  'settingsPanel.patternBlock.groupAria': {
    en: '{feature}: pattern', de: '{feature}: Muster', es: '{feature}: patrón', fr: '{feature} : motif',
    ja: '{feature}：パターン', ko: '{feature}: 패턴', ru: '{feature}: паттерн', zh: '{feature}：模式',
  },
  'settingsPanel.patternBlock.oneShotHintGap': {
    en: 'An ending: it plays once at the start of each gap, then holds its last position until the gap ends.',
    de: 'Ein Abschluss: Er läuft am Anfang jeder Lücke einmal ab und hält dann seine letzte Position, bis die Lücke endet.',
    es: 'Un final: se reproduce una vez al comienzo de cada hueco y luego mantiene su última posición hasta que el hueco termina.',
    fr: "Une fin : elle est jouée une fois au début de chaque blanc, puis garde sa dernière position jusqu'à la fin du blanc.",
    ja: 'エンディング：各ギャップの始めに1回だけ再生され、ギャップが終わるまで最後の位置を保持します。',
    ko: '마무리: 각 간격이 시작될 때 한 번 재생되고, 간격이 끝날 때까지 마지막 위치를 유지합니다.',
    ru: 'Концовка: проигрывается один раз в начале каждой паузы, затем держит последнее положение до конца паузы.',
    zh: '结尾：在每个空隙开始时播放一次，然后保持最后的位置，直到空隙结束。',
  },
  'settingsPanel.patternBlock.setPattern': {
    en: 'Set pattern…', de: 'Muster festlegen…', es: 'Elegir patrón…', fr: 'Définir le motif…',
    ja: 'パターンを設定…', ko: '패턴 설정…', ru: 'Задать паттерн…', zh: '设置模式…',
  },
  'settingsPanel.patternBlock.setPatternAria': {
    en: 'Set the {feature} pattern',
    de: 'Muster für {feature} festlegen',
    es: 'Elegir el patrón de {feature}',
    fr: 'Définir le motif de {feature}',
    ja: '{feature}のパターンを設定',
    ko: '{feature} 패턴 설정',
    ru: 'Задать паттерн для {feature}',
    zh: '设置{feature}的模式',
  },
  'settingsPanel.patternBlock.drawerTitle': {
    en: '{feature} pattern', de: 'Muster für {feature}', es: 'Patrón de {feature}', fr: 'Motif de {feature}',
    ja: '{feature}のパターン', ko: '{feature} 패턴', ru: 'Паттерн для {feature}', zh: '{feature}的模式',
  },
  'settingsPanel.patternBlock.apply': {
    en: 'Apply', de: 'Übernehmen', es: 'Aplicar', fr: 'Appliquer',
    ja: '適用', ko: '적용', ru: 'Применить', zh: '应用',
  },
  'settingsPanel.patternBlock.summary': {
    en: '{name}, {speed} units/s, {range}',
    de: '{name}, {speed} Einheiten/s, {range}',
    es: '{name}, {speed} unidades/s, {range}',
    fr: '{name}, {speed} unités/s, {range}',
    ja: '{name}、{speed} ユニット/秒、{range}',
    ko: '{name}, {speed} 단위/초, {range}',
    ru: '{name}, {speed} ед/с, {range}',
    zh: '{name}，{speed} 单位/秒，{range}',
  },
  'settingsPanel.patternBlock.summaryReversed': {
    en: '{name}, {speed} units/s, reversed, {range}',
    de: '{name}, {speed} Einheiten/s, umgekehrt, {range}',
    es: '{name}, {speed} unidades/s, invertido, {range}',
    fr: '{name}, {speed} unités/s, inversé, {range}',
    ja: '{name}、{speed} ユニット/秒、反転、{range}',
    ko: '{name}, {speed} 단위/초, 반전, {range}',
    ru: '{name}, {speed} ед/с, наоборот, {range}',
    zh: '{name}，{speed} 单位/秒，反向，{range}',
  },
  'settingsPanel.patternBlock.summaryRangeOwn': {
    en: 'its own range', de: 'eigener Bereich', es: 'su propio rango', fr: 'sa propre plage',
    ja: '本来の範囲', ko: '고유 범위', ru: 'собственный диапазон', zh: '自身范围',
  },
  'settingsPanel.patternBlock.summaryRangeExact': {
    en: '{lo} to {hi}', de: '{lo} bis {hi}', es: 'de {lo} a {hi}', fr: 'de {lo} à {hi}',
    ja: '{lo}～{hi}', ko: '{lo}~{hi}', ru: 'от {lo} до {hi}', zh: '{lo} 至 {hi}',
  },
  'settingsPanel.patternBlock.summaryRangeScript': {
    en: 'follows the script at {pct}%',
    de: 'folgt dem Skript mit {pct} %',
    es: 'sigue el script al {pct} %',
    fr: 'suit le script à {pct} %',
    ja: 'スクリプトに合わせて {pct}%',
    ko: '스크립트를 따라 {pct}%',
    ru: 'следует скрипту на {pct} %',
    zh: '跟随脚本 {pct}%',
  },
  'settingsPanel.patternBlock.summaryNone': {
    en: 'No pattern chosen yet', de: 'Noch kein Muster gewählt', es: 'Aún no hay patrón elegido', fr: 'Aucun motif choisi pour le moment',
    ja: 'まだパターンが選ばれていません', ko: '아직 선택한 패턴이 없습니다', ru: 'Паттерн ещё не выбран', zh: '尚未选择模式',
  },
  'settingsPanel.playback.fillerThreshold': {
    en: 'Fill gaps longer than', de: 'Lücken füllen ab', es: 'Rellenar huecos de más de', fr: 'Remplir les blancs de plus de',
    ja: 'この長さを超えるギャップを埋める', ko: '다음보다 긴 간격 채우기', ru: 'Заполнять паузы длиннее', zh: '填充长于此值的空隙',
  },
  'settingsPanel.playback.fillerResetThresholdAria': {
    en: 'Reset the gap filler threshold to its default (10s)',
    de: 'Schwelle des Lückenfüllers auf Standard zurücksetzen (10s)',
    es: 'Restablecer el umbral del relleno de huecos al predeterminado (10s)',
    fr: 'Réinitialiser le seuil du remplissage des blancs par défaut (10s)',
    ja: 'ギャップフィラーのしきい値をデフォルトにリセット (10秒)',
    ko: '간격 채우기 임계값을 기본값으로 재설정 (10초)',
    ru: 'Сбросить порог заполнения пауз на значение по умолчанию (10с)',
    zh: '将空隙填充阈值重置为默认 (10 秒)',
  },
};

export const PATTERN_BLOCK_LOCALES = Object.freeze(['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']);

/** A copy of a locale bundle with the block's strings set (dotted keys). */
export function withPatternBlockStrings(bundle, locale) {
  const out = JSON.parse(JSON.stringify(bundle || {}));
  for (const [key, byLocale] of Object.entries(PATTERN_BLOCK_STRINGS)) {
    const value = byLocale[locale];
    if (value === undefined) continue;
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) {
      if (!node[p] || typeof node[p] !== 'object') node[p] = {};
      node = node[p];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}
