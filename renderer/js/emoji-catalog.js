// Emoji catalogue for the category icon picker.
//
// Deliberately a CURATED list rather than a generated dump of the whole
// Unicode emoji set. The full set is ~3,800 characters including every skin
// tone and gender variant of the same person, which makes a picker slower to
// render, far slower to support-test, and much harder to scan. What is here
// is one representative per concept, chosen for things people would
// plausibly name a category after.
//
// MODERN EMOJI ARE INCLUDED ON PURPOSE. An earlier version of this file was
// almost entirely pre-2019 characters and looked dated next to the OS
// picker. Everything from Unicode 12 through 16 that is genuinely useful is
// here — melting face, heart hands, the coloured hearts, the newer animals
// and objects, and so on.
//
// Including new emoji is SAFE because we ship the artwork rather than trusting
// the platform font. Windows renders through Segoe UI Emoji and most Linux
// desktops through Noto Color Emoji, both of which lag the Unicode spec by a
// variable amount and differ build to build — so this used to be gated by
// canvas measurement (draw the glyph, compare against tofu). Bundling Twemoji
// made that unnecessary: every entry below is backed by an SVG, and the picker
// filters on emojiAssetPath() — "did we bundle this?" — not on what the local
// font happens to cover. That is what makes listing Unicode 15 and 16
// characters here reasonable. Font rendering survives only as the <img>
// onerror fallback in emoji-asset.js.
//
// Groups follow the Unicode emoji ordering loosely, so the layout matches
// what people are used to from OS pickers.

import { registerAvailableAssets } from './emoji-asset.js';
import { BUNDLED_EMOJI_ASSETS } from './emoji-assets-manifest.js';

// Tell the asset layer which Twemoji files actually shipped, so it never
// points an <img> at artwork we did not bundle.
registerAvailableAssets(BUNDLED_EMOJI_ASSETS);

/** @typedef {{ id: string, labelKey: string, emoji: string[] }} EmojiGroup */

/** @type {EmojiGroup[]} */
export const EMOJI_GROUPS = [
  {
    id: 'smileys',
    labelKey: 'emoji.group.smileys',
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '🫠', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚',
      '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶',
      '🫥', '😶‍🌫️', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '🫨', '🙂‍↔️',
      '😌', '😔', '😪', '🤤', '😴', '🫩', '😷', '🤒', '🤕', '🤢',
      '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '😵‍💫', '🤯', '🤠', '🥳',
      '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '😮', '😯',
      '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢',
      '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤',
      '😡', '😠', '🤬', '😈', '👿', '💀', '💩', '🤡', '👻', '👽',
      '🤖', '😺', '😻', '😽', '🙀', '😿',
    ],
  },
  {
    id: 'people',
    labelKey: 'emoji.group.people',
    emoji: [
      '👋', '🤚', '🖐', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '🫰',
      '👌', '🤌', '🤏', '✌', '🤞', '🫵', '🤟', '🤘', '🤙', '👈',
      '👉', '👆', '👇', '☝', '👍', '👎', '✊', '👊', '🤛', '🤜',
      '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💅', '🤳', '💪',
      '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁',
      '🦷', '🦴', '👀', '👁', '👅', '👄', '🫦', '💋', '🩸', '🫆',
      '👶', '🧒', '👦', '👧', '🧑', '👨', '👩', '🧔', '👱', '👴',
      '👵', '🧓', '🙍', '🙎', '🙅', '🙆', '💁', '🙋', '🧏', '🙇',
      '🤦', '🤷', '💃', '🕺', '👯', '🧖', '🧘', '🛌', '🫂', '👤',
      '👥', '🗣', '👣', '🧚', '🧜', '🧞', '🦸', '🦹',
    ],
  },
  {
    id: 'hearts',
    labelKey: 'emoji.group.hearts',
    emoji: [
      '❤', '🩷', '🧡', '💛', '💚', '💙', '🩵', '💜', '🤎', '🖤',
      '🩶', '🤍', '💔', '❤️‍🔥', '❤️‍🩹', '❣', '💕', '💞', '💓', '💗',
      '💖', '💘', '💝', '💟', '♥', '💯', '💢', '💥', '💫', '💦',
      '💨', '🕳', '💬', '💭', '💤', '⭐', '🌟', '✨', '⚡', '🔥',
      '🌈', '☀', '🌙', '☁', '❄', '🎵', '🎶', '➕', '➖', '✔',
      '❌', '❓', '❗', '‼', '⭕', '🔴', '🟠', '🟡', '🟢', '🔵',
      '🟣', '🟤', '⚫', '⚪', '🔺', '🔻', '🔶', '🔷', '🔸', '🔹',
      '🔘', '🔳', '🔲', '♦', '♠', '♣', '🃏', '🎴',
    ],
  },
  {
    id: 'nature',
    labelKey: 'emoji.group.nature',
    emoji: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧',
      '🐦', '🐦‍⬛', '🐤', '🦆', '🦢', '🦅', '🦉', '🪶', '🪽', '🪿',
      '🦇', '🐺', '🐗', '🐴', '🦄', '🫎', '🫏', '🐝', '🪲', '🐛',
      '🦋', '🐌', '🐞', '🐜', '🪳', '🪰', '🪱', '🕷', '🦂', '🐢',
      '🐍', '🦎', '🐙', '🦑', '🪼', '🦐', '🦞', '🦀', '🪸', '🐡',
      '🐠', '🐟', '🐬', '🐳', '🦈', '🐊', '🐅', '🦓', '🦍', '🐘',
      '🦣', '🦏', '🐪', '🦒', '🦫', '🦤', '🌵', '🌲', '🌳', '🌴',
      '🪴', '🌱', '🌿', '☘', '🍀', '🍁', '🍂', '🍄', '🍄‍🟫', '🪵',
      '🌷', '🌹', '🥀', '🌺', '🌸', '🌼', '🌻', '🪷', '🪻', '💐',
      '🌊', '🌋', '🏔', '🪐',
    ],
  },
  {
    id: 'food',
    labelKey: 'emoji.group.food',
    emoji: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
      '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🫒', '🥑',
      '🍆', '🥔', '🥕', '🌽', '🌶', '🫑', '🥒', '🥬', '🥦', '🧄',
      '🧅', '🥜', '🫘', '🌰', '🫚', '🫛', '🍞', '🥐', '🥖', '🫓',
      '🥨', '🥯', '🥞', '🧇', '🧀', '🍖', '🍗', '🥩', '🥓', '🍔',
      '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥚',
      '🍳', '🥘', '🍲', '🫕', '🥣', '🥗', '🍿', '🧈', '🧂', '🍝',
      '🍜', '🍣', '🍤', '🥟', '🥠', '🥡', '🍦', '🍰', '🧁', '🥧',
      '🍫', '🍬', '🍭', '🍩', '🍪', '🍯', '🍼', '🥛', '☕', '🫖',
      '🍵', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🧊',
      '🧋', '🧃', '🫗', '🫙',
    ],
  },
  {
    id: 'activity',
    labelKey: 'emoji.group.activity',
    emoji: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🪀', '🏓', '🏸', '🥅', '🏒', '🏑', '🥍', '🏏', '🪃', '🥊',
      '🥋', '⛳', '⛸', '🎣', '🤿', '🎽', '🎿', '🛷', '🥌', '🎯',
      '🪁', '🎮', '🕹', '🎲', '🧩', '🎰', '🎳', '🎭', '🎨', '🎬',
      '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸',
      '🪕', '🎻', '🪈', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖', '🎗',
      '🎟', '🎫', '🎪', '🤹', '🎠', '🎡', '🎢', '🩰', '🪅', '🪆',
      '🪄',
    ],
  },
  {
    id: 'objects',
    labelKey: 'emoji.group.objects',
    emoji: [
      '⌚', '📱', '💻', '⌨', '🖥', '🖨', '🖱', '💾', '💿', '📀',
      '📷', '📸', '📹', '🎥', '📽', '📺', '📻', '🎙', '⏱', '⏲',
      '⏰', '🕰', '⏳', '📡', '🔋', '🪫', '🔌', '💡', '🔦', '🕯',
      '🧯', '🛢', '💸', '💵', '💰', '🪙', '💳', '💎', '⚖', '🪜',
      '🧰', '🪛', '🔧', '🔨', '⚒', '🛠', '⛏', '🪚', '🔩', '⚙',
      '🪤', '🧲', '🔫', '💣', '🪓', '🔪', '🗡', '⚔', '🛡', '🚬',
      '⚰', '🪦', '🔮', '🧿', '🪬', '🧸', '🖼', '🪞', '🪟',
      '🛍', '🎁', '🎈', '🎉', '🎊', '🎀', '🪩', '🔑', '🗝', '🔒',
      '🔓', '🔗', '⛓', '🪝', '📌', '📎', '📏', '📐', '✂', '🗑',
      '📦', '📚', '📖', '📝', '✏', '🖊', '🖌', '🔍', '🔎', '💊',
      '🩹', '🩼', '🩻', '🌡', '🚿', '🛁', '🪠', '🪥', '🪒', '🧼',
      '🫧', '🪮', '🪭', '🪑', '🛗',
    ],
  },
  {
    id: 'travel',
    labelKey: 'emoji.group.travel',
    emoji: [
      '🚗', '🚕', '🚙', '🚌', '🏎', '🚓', '🚑', '🚒', '🚚', '🛻',
      '🚜', '🏍', '🛵', '🚲', '🛴', '🛼', '🛞', '✈', '🚀', '🛸',
      '🚁', '⛵', '🚤', '🛥', '🚢', '🛟', '⚓', '🚂', '🚆', '🚊',
      '🗺', '🧭', '🏕', '🏖', '🏜', '🏝', '🛖', '🏠', '🏡', '🏢',
      '🏰', '🗼', '🗽', '⛲', '🌃', '🌆', '🌇', '🌉', '🎆', '🎇',
      '🌌', '🛝',
    ],
  },
];

/** Every emoji in the catalogue, flattened. */
export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.emoji);

/**
 * Quick picks shown first — the handful most likely to be wanted, so the
 * common case needs no scrolling.
 */
export const QUICK_EMOJI = ['🔥', '💦', '⭐', '❤', '🎬', '🍑', '⚡', '🌙'];
