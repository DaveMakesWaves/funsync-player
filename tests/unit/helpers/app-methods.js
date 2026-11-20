// Lift REAL methods out of renderer/js/app.js into a class a test can build.
//
// app.js instantiates itself on import, so it cannot be imported by a test.
// video-load-errors.test.js and recovery-toast.test.js lift method bodies out
// of the source instead and run them against recording fakes; this is the
// same brace-matching lifter, shared, so a new test does not grow a third
// copy. What a lifted test asserts is still the observable effect (messages
// relayed, play() calls, toasts), never the source text.
import fs from 'node:fs';

export const APP_SRC = fs.readFileSync('renderer/js/app.js', 'utf8');

/**
 * Return the full text of a class method (signature + body) from app.js.
 * Skips strings, template literals and comments while matching braces, so
 * a `{` inside a comment or a string can't end the method early.
 */
export function liftMethod(src, name) {
  const re = new RegExp(`^  (?:async )?${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`${name}() not found in app.js`);
  const start = m.index;
  // End of the parameter list (parameters can hold `{ ... } = {}`).
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) break;
  }
  i = src.indexOf('{', i);
  return src.slice(start, closingBrace(src, i, name) + 1);
}

/**
 * Index of the `}` that closes the `{` at `open`, skipping strings, template
 * literals and comments the same way for methods and object literals.
 */
function closingBrace(src, open, name) {
  let depth = 0;
  const templates = []; // brace depth at which each open `${` resumes its template
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') templates.pop();
      // Inside a template literal: run to its end or to the next `${`.
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '`') break;
        if (src[i] === '$' && src[i + 1] === '{') { templates.push(depth); i++; break; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * The options object app.js hands `new <className>({ ... })`, lifted as a
 * factory: call the result with `this` bound to an app-shaped object and it
 * returns the REAL option wiring, every key and every arrow callback exactly
 * as init() builds them. `deps` maps the free identifiers the literal uses
 * (imports such as `showToast`, `t`) to the values to give them.
 */
export function liftCtorOptions(className, deps = {}) {
  const anchor = `new ${className}({`;
  const at = APP_SRC.indexOf(anchor);
  if (at < 0) throw new Error(`${anchor} not found in app.js`);
  if (APP_SRC.indexOf(anchor, at + 1) >= 0) throw new Error(`${anchor} appears more than once in app.js`);
  const open = at + anchor.length - 1;
  const literal = APP_SRC.slice(open, closingBrace(APP_SRC, open, className) + 1);
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const make = new Function(...keys, `return function () { return (${literal}); };`);
  return make(...keys.map((k) => deps[k]));
}

/**
 * Build a class holding the named app.js methods. `deps` maps each free
 * identifier the methods use (imports, globals) to the value to give it.
 */
export function liftAppClass(names, deps) {
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const make = new Function(...keys,
    `return class LiftedApp {\n${names.map((n) => liftMethod(APP_SRC, n)).join('\n\n')}\n};`);
  return make(...keys.map((k) => deps[k]));
}
