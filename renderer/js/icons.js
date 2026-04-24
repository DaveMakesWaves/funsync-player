// Lucide Icons — centralized icon helper for FunSync Player
//
// Uses the same relative-path import pattern as handy-sdk
// (bare specifiers fail in Electron renderer with contextIsolation: true).

import createElement from '../../node_modules/lucide/dist/esm/createElement.js';
export { createIcons } from '../../node_modules/lucide/dist/esm/lucide.js';

// Icon node definitions (each is an array of SVG child elements)
export { default as Play } from '../../node_modules/lucide/dist/esm/icons/play.js';
export { default as Pause } from '../../node_modules/lucide/dist/esm/icons/pause.js';
export { default as Volume2 } from '../../node_modules/lucide/dist/esm/icons/volume-2.js';
export { default as VolumeX } from '../../node_modules/lucide/dist/esm/icons/volume-x.js';
export { default as FolderOpen } from '../../node_modules/lucide/dist/esm/icons/folder-open.js';
export { default as Folder } from '../../node_modules/lucide/dist/esm/icons/folder.js';
export { default as ChevronRight } from '../../node_modules/lucide/dist/esm/icons/chevron-right.js';
export { default as GripVertical } from '../../node_modules/lucide/dist/esm/icons/grip-vertical.js';
export { default as Smartphone } from '../../node_modules/lucide/dist/esm/icons/smartphone.js';
export { default as Goggles } from '../../node_modules/lucide/dist/esm/icons/rectangle-goggles.js';
export { default as Bluetooth } from '../../node_modules/lucide/dist/esm/icons/bluetooth.js';
export { default as Maximize } from '../../node_modules/lucide/dist/esm/icons/maximize.js';
export { default as Minimize } from '../../node_modules/lucide/dist/esm/icons/minimize.js';
export { default as ArrowLeft } from '../../node_modules/lucide/dist/esm/icons/arrow-left.js';
export { default as Plus } from '../../node_modules/lucide/dist/esm/icons/plus.js';
export { default as Home } from '../../node_modules/lucide/dist/esm/icons/house.js';
export { default as Library } from '../../node_modules/lucide/dist/esm/icons/library.js';
export { default as ListVideo } from '../../node_modules/lucide/dist/esm/icons/list-video.js';
export { default as Tag } from '../../node_modules/lucide/dist/esm/icons/tag.js';
export { default as EllipsisVertical } from '../../node_modules/lucide/dist/esm/icons/ellipsis-vertical.js';
export { default as Pencil } from '../../node_modules/lucide/dist/esm/icons/pencil.js';
export { default as Trash2 } from '../../node_modules/lucide/dist/esm/icons/trash-2.js';
export { default as X } from '../../node_modules/lucide/dist/esm/icons/x.js';
export { default as Clapperboard } from '../../node_modules/lucide/dist/esm/icons/clapperboard.js';
export { default as PictureInPicture2 } from '../../node_modules/lucide/dist/esm/icons/picture-in-picture-2.js';
export { default as SkipBack } from '../../node_modules/lucide/dist/esm/icons/skip-back.js';
export { default as SkipForward } from '../../node_modules/lucide/dist/esm/icons/skip-forward.js';
export { default as Undo2 } from '../../node_modules/lucide/dist/esm/icons/undo-2.js';
export { default as Redo2 } from '../../node_modules/lucide/dist/esm/icons/redo-2.js';
export { default as Save } from '../../node_modules/lucide/dist/esm/icons/save.js';
export { default as ZoomIn } from '../../node_modules/lucide/dist/esm/icons/zoom-in.js';
export { default as ZoomOut } from '../../node_modules/lucide/dist/esm/icons/zoom-out.js';
export { default as Magnet } from '../../node_modules/lucide/dist/esm/icons/magnet.js';
export { default as FlipVertical2 } from '../../node_modules/lucide/dist/esm/icons/flip-vertical-2.js';
export { default as Spline } from '../../node_modules/lucide/dist/esm/icons/spline.js';
export { default as Scissors } from '../../node_modules/lucide/dist/esm/icons/scissors.js';
export { default as WandSparkles } from '../../node_modules/lucide/dist/esm/icons/wand-sparkles.js';
export { default as BookmarkPlus } from '../../node_modules/lucide/dist/esm/icons/bookmark-plus.js';
export { default as FileText } from '../../node_modules/lucide/dist/esm/icons/file-text.js';
export { default as Rows3 } from '../../node_modules/lucide/dist/esm/icons/rows-3.js';
export { default as AudioWaveform } from '../../node_modules/lucide/dist/esm/icons/audio-waveform.js';
export { default as Activity } from '../../node_modules/lucide/dist/esm/icons/activity.js';
export { default as Info } from '../../node_modules/lucide/dist/esm/icons/info.js';
export { default as FileCheck } from '../../node_modules/lucide/dist/esm/icons/file-check.js';
export { default as FileX } from '../../node_modules/lucide/dist/esm/icons/file-x.js';
export { default as Gauge } from '../../node_modules/lucide/dist/esm/icons/gauge.js';
export { default as Music } from '../../node_modules/lucide/dist/esm/icons/music.js';
export { default as Captions } from '../../node_modules/lucide/dist/esm/icons/captions.js';
export { default as RotateCcw } from '../../node_modules/lucide/dist/esm/icons/rotate-ccw.js';
export { default as Download } from '../../node_modules/lucide/dist/esm/icons/download.js';
export { default as LayoutGrid } from '../../node_modules/lucide/dist/esm/icons/layout-grid.js';
export { default as LayoutList } from '../../node_modules/lucide/dist/esm/icons/layout-list.js';
export { default as Unplug } from '../../node_modules/lucide/dist/esm/icons/unplug.js';
export { default as Settings } from '../../node_modules/lucide/dist/esm/icons/settings.js';

/**
 * Create an SVG element from a Lucide icon node.
 * @param {Array} iconNode — icon definition array (e.g. Play, Pause)
 * @param {Object} [attrs] — override attributes (width, height, stroke-width, class, etc.)
 * @returns {SVGElement}
 */
export function icon(iconNode, attrs = {}) {
  return createElement(iconNode, {
    width: 20,
    height: 20,
    'stroke-width': 1.75,
    ...attrs,
  });
}
