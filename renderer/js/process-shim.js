// Polyfill process.env for npm packages that reference process.env.NODE_ENV
// (e.g. @ohdoki/handy-sdk bundles mitt which checks process.env.NODE_ENV)
// This is needed because Electron renderer with contextIsolation has no `process` global.
window.process = { env: { NODE_ENV: 'production' } };
