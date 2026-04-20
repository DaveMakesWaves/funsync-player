// Global test setup — mocks for Electron IPC, DOM APIs, and browser globals
import { vi } from 'vitest';

// --- window.funsync IPC mock (matches electron/preload.js) ---
window.funsync = {
  openFileDialog: vi.fn().mockResolvedValue([]),
  readFunscript: vi.fn().mockResolvedValue(null),
  writeFunscript: vi.fn().mockResolvedValue(null),
  saveFunscript: vi.fn().mockResolvedValue(null),
  convertFunscript: vi.fn().mockResolvedValue({
    csv: '',
    hash: 'test',
    local_url: 'http://localhost:5123/scripts/test.csv',
    size_bytes: 0,
    action_count: 0,
    duration_ms: 0,
  }),
  generateThumbnails: vi.fn().mockResolvedValue({ thumbnails: [], interval: 10, count: 0 }),
  fetchMetadata: vi.fn().mockResolvedValue(null),
  selectDirectory: vi.fn().mockResolvedValue(null),
  scanDirectory: vi.fn().mockResolvedValue({ videos: [], unmatchedFunscripts: [] }),
  selectFunscript: vi.fn().mockResolvedValue(null),
  selectSubtitle: vi.fn().mockResolvedValue(null),
  getBackendPort: vi.fn().mockResolvedValue(5123),
  getAppVersion: vi.fn().mockResolvedValue('0.1.0'),

  // File utilities
  fileExists: vi.fn().mockResolvedValue(true),

  // Data export/import
  exportData: vi.fn().mockResolvedValue({ success: true, path: '/tmp/backup.zip' }),
  importData: vi.fn().mockResolvedValue({ success: true, funscriptCount: 0 }),

  // Shell
  openExternal: vi.fn().mockResolvedValue(undefined),
  showInFolder: vi.fn().mockResolvedValue(undefined),

  // VR Bridge
  vrConnect: vi.fn().mockResolvedValue({ success: true }),
  vrDisconnect: vi.fn().mockResolvedValue({ success: true }),
  vrSend: vi.fn().mockResolvedValue(true),
  onVrState: vi.fn().mockReturnValue(() => {}),
  onVrDisconnected: vi.fn().mockReturnValue(() => {}),

  // Autoblow
  autoblowConnect: vi.fn().mockResolvedValue({ success: false, error: 'mock' }),
  autoblowDisconnect: vi.fn().mockResolvedValue({ success: true }),
  autoblowStatus: vi.fn().mockResolvedValue({ connected: false }),
  autoblowUploadScript: vi.fn().mockResolvedValue({ success: true }),
  autoblowSyncStart: vi.fn().mockResolvedValue({ success: true }),
  autoblowSyncStop: vi.fn().mockResolvedValue({ success: true }),
  autoblowSyncOffset: vi.fn().mockResolvedValue({ success: true }),
  autoblowLatency: vi.fn().mockResolvedValue({ success: true, latency: 50 }),

  // TCode Serial
  tcodeListPorts: vi.fn().mockResolvedValue([]),
  tcodeConnect: vi.fn().mockResolvedValue({ success: true }),
  tcodeDisconnect: vi.fn().mockResolvedValue({ success: true }),
  tcodeSend: vi.fn().mockResolvedValue(true),
  tcodeStatus: vi.fn().mockResolvedValue({ connected: false }),
  onTcodeDisconnected: vi.fn().mockReturnValue(() => {}),

  // EroScripts
  eroscriptsLogin: vi.fn().mockResolvedValue({ success: false, error: 'mock' }),
  eroscriptsVerify2FA: vi.fn().mockResolvedValue({ success: false, error: 'mock' }),
  eroscriptsLogout: vi.fn().mockResolvedValue({ success: true }),
  eroscriptsRestoreSession: vi.fn().mockResolvedValue({ success: true }),
  eroscriptsStatus: vi.fn().mockResolvedValue({ loggedIn: false }),
  eroscriptsValidate: vi.fn().mockResolvedValue({ valid: false }),
  eroscriptsSearch: vi.fn().mockResolvedValue({ results: [] }),
  eroscriptsTopic: vi.fn().mockResolvedValue({ attachments: [] }),
  eroscriptsTopicImage: vi.fn().mockResolvedValue(null),
  eroscriptsDownload: vi.fn().mockResolvedValue({ success: true }),

  // Auto-updater
  updaterCheck: vi.fn().mockResolvedValue(undefined),
  updaterDownload: vi.fn().mockResolvedValue(undefined),
  updaterInstall: vi.fn().mockResolvedValue(undefined),
  onUpdateEvent: vi.fn().mockReturnValue(() => {}),

  // Data store IPC methods
  getAllData: vi.fn().mockResolvedValue({
    settings: {
      handy: {
        connectionKey: '',
        defaultOffset: 0,
        slideMin: 0,
        slideMax: 100,
        scriptHostMode: 'local',
        syncRounds: 30,
      },
      player: {
        volume: 80,
        theme: 'dark',
        recentFiles: [],
        gapSkip: {
          mode: 'off',
          threshold: 10000,
        },
        smoothing: 'linear',
        speedLimit: 0,
      },
      backend: {
        port: 5123,
        localIp: 'auto',
      },
      library: {
        directory: '',
        sources: [],
        associations: {},
        manualVariants: {},
        collections: [],
        activeCollectionId: null,
      },
      editor: {
        defaultCreator: '',
        patternPresets: [],
      },
      knownDevices: [],
      buttplug: {
        port: 12345,
      },
      tcode: {
        port: '',
        baudRate: 115200,
        axisRanges: {},
        axisEnabled: {},
      },
      autoblow: {
        token: '',
        offset: 0,
      },
    },
    playlists: [],
    categories: [],
    videoCategories: {},
    _migrated: true,
  }),
  getSetting: vi.fn().mockResolvedValue(undefined),
  setSetting: vi.fn().mockResolvedValue(undefined),
  addRecentFile: vi.fn().mockResolvedValue(undefined),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylist: vi.fn().mockResolvedValue(null),
  addPlaylist: vi.fn().mockImplementation((name) =>
    Promise.resolve({ id: crypto.randomUUID(), name, createdAt: Date.now(), videoPaths: [] })
  ),
  renamePlaylist: vi.fn().mockResolvedValue(undefined),
  deletePlaylist: vi.fn().mockResolvedValue(undefined),
  addVideoToPlaylist: vi.fn().mockResolvedValue(undefined),
  removeVideoFromPlaylist: vi.fn().mockResolvedValue(undefined),
  getCategories: vi.fn().mockResolvedValue([]),
  addCategory: vi.fn().mockImplementation((name, color) =>
    Promise.resolve({ id: crypto.randomUUID(), name, color })
  ),
  renameCategory: vi.fn().mockResolvedValue(undefined),
  deleteCategory: vi.fn().mockResolvedValue(undefined),
  assignCategory: vi.fn().mockResolvedValue(undefined),
  unassignCategory: vi.fn().mockResolvedValue(undefined),
  getVideoCategories: vi.fn().mockResolvedValue([]),
  getVideosByCategory: vi.fn().mockResolvedValue([]),
  migrateLocalStorage: vi.fn().mockResolvedValue({ success: true }),
};

// --- Canvas 2D context mock ---
const mockCtx = {
  save: vi.fn(),
  restore: vi.fn(),
  setTransform: vi.fn(),
  scale: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  drawImage: vi.fn(),
  measureText: vi.fn().mockReturnValue({ width: 50 }),
  roundRect: vi.fn(),
  fillText: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: '',
  textBaseline: '',
  globalAlpha: 1,
  canvas: { width: 800, height: 400 },
};

const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === '2d') return mockCtx;
  return _origGetContext.call(this, type);
};

// --- requestAnimationFrame / cancelAnimationFrame ---
let _rafId = 0;
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb) => ++_rafId;
}
if (!window.cancelAnimationFrame) {
  window.cancelAnimationFrame = () => {};
}

// --- ResizeObserver ---
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// --- URL.createObjectURL / revokeObjectURL ---
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}

// --- Path2D ---
if (!window.Path2D) {
  window.Path2D = class {
    constructor() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
    arc() {}
    rect() {}
  };
}

// --- devicePixelRatio ---
if (!window.devicePixelRatio) {
  window.devicePixelRatio = 1;
}

// --- crypto.randomUUID ---
if (!crypto.randomUUID) {
  crypto.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  };
}
