'use strict';
// Minimal parser for Valve KeyValues text files (libraryfolders.vdf,
// registry.vdf, appmanifest_*.acf). Returns nested plain objects. Keys keep
// their case; use `get()` for case-insensitive lookups, because Steam is not
// consistent (e.g. "apps" vs "Apps").

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '{' || c === '}') {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const n = text[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          s += text[i++];
        }
      }
      i++;
      tokens.push({ s });
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let s = '';
      while (i < text.length && !/[\s{}"]/.test(text[i])) s += text[i++];
      tokens.push({ s });
    }
  }
  return tokens;
}

function parse(text) {
  const tokens = tokenize(String(text));
  let pos = 0;
  function block() {
    const obj = {};
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t === '}') return obj;
      if (t === '{') continue; // stray brace, ignore
      const key = t.s;
      const next = tokens[pos++];
      if (next === '{') obj[key] = block();
      else if (next && next !== '}') obj[key] = next.s;
      else break;
    }
    return obj;
  }
  return block();
}

/** Case-insensitive path lookup: get(obj, 'Registry', 'HKCU', 'Software'). */
function get(obj, ...path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    const want = String(p).toLowerCase();
    const key = Object.keys(cur).find((k) => k.toLowerCase() === want);
    if (key === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

module.exports = { parse, get };
