/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The emoji build step must be able to read the catalogue.
//
// v0.9.1 failed CI on BOTH platforms at "Fetch Twemoji artwork":
//
//   TypeError [ERR_UNSUPPORTED_RESOLVE_REQUEST]: Failed to resolve module
//   specifier "./emoji-asset.js" from "data:text/javascript;base64,..."
//
// The script evaluates emoji-catalog.js as a data: URL, and a data: URL has no
// hierarchical base, so it cannot resolve ANY relative import. Adding a single
// `import ... from './emoji-asset.js'` line to the catalogue broke the release
// build — and nothing caught it, because 3,557 tests all exercised the
// catalogue as a browser module (where the import resolves fine) and none
// exercised it the way the BUILD loads it.
//
// That is the same shape as the electron-module-exports hole: the code was
// valid, the tests were green, and the only thing that would have caught it was
// running the real entry point. Hence this file.
import { describe, it, expect } from 'vitest';
import { stripImports, loadCatalogue, twemojiCandidates } from '../../scripts/fetch-twemoji.mjs';

describe('loadCatalogue', () => {
  // THE REGRESSION TEST. If this throws, the release build fails.
  it('reads the real catalogue without a module-resolution error', async () => {
    const all = await loadCatalogue();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(500);
  });

  it('returns actual emoji, not source fragments', async () => {
    const all = await loadCatalogue();
    for (const e of all.slice(0, 40)) {
      expect(typeof e).toBe('string');
      expect(e.length).toBeLessThan(12);
      expect(e).not.toMatch(/[a-zA-Z;{}]/);
    }
  });

  it('every entry maps to at least one Twemoji filename', async () => {
    const all = await loadCatalogue();
    for (const e of all) {
      const names = twemojiCandidates(e);
      expect(names.length).toBeGreaterThan(0);
      expect(names[0]).toMatch(/^[0-9a-f]+(-[0-9a-f]+)*$/);
    }
  });
});

describe('stripImports', () => {
  it('removes a relative import and the call that used it', () => {
    const out = stripImports(
      "import { registerAvailableAssets } from './emoji-asset.js';\n" +
      "import { BUNDLED } from './emoji-assets-manifest.js';\n" +
      'registerAvailableAssets(BUNDLED);\n' +
      "export const ALL = ['a'];\n",
    );
    expect(out).not.toMatch(/^import/m);
    expect(out).not.toMatch(/registerAvailableAssets\(/);
    expect(out).toMatch(/export const ALL/);
  });

  it('handles default and namespace imports', () => {
    const out = stripImports(
      "import thing from './x.js';\nimport * as ns from './y.js';\nthing();\nns.go();\nexport const K = 1;\n",
    );
    expect(out).not.toMatch(/^import/m);
    expect(out).toMatch(/export const K/);
    expect(out).not.toMatch(/thing\(\)/);
  });

  it('leaves a module with no imports untouched', () => {
    const src = "export const ALL = ['x'];\n";
    expect(stripImports(src)).toBe(src);
  });

  // The stripper must not eat the data. An over-broad filter that dropped every
  // line mentioning an imported name would silently return an empty catalogue,
  // and the build would "succeed" having fetched nothing.
  it('does not drop unrelated lines', () => {
    const out = stripImports(
      "import { a } from './z.js';\nexport const EMOJI = ['x', 'y'];\nexport const N = 2;\n",
    );
    expect(out).toMatch(/EMOJI/);
    expect(out).toMatch(/export const N = 2/);
  });
});
