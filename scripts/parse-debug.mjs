// Local Node harness: run the JSOS browser HTML/CSS parse pipeline on a saved
// page and report what survives to layout. Uses the transpiled build output.
// Usage: node scripts/parse-debug.mjs test-output/mojeek.html
import { readFileSync } from 'fs';

// Minimal kernel stub for modules that touch `kernel` at import/parse time
globalThis.kernel = {
  getTicks: () => Date.now(),
  serialPut: () => {},
  sleep: () => {},
};

const htmlPath = process.argv[2] || 'test-output/mojeek.html';
const html = readFileSync(htmlPath, 'utf8');

const { tokenise, parseHTMLFromTokens } = await import('../build/js/apps/browser/html.js');
const { parseStylesheet, buildSheetIndex } = await import('../build/js/apps/browser/stylesheet.js');

const tokens = tokenise(html);
console.log('tokens:', tokens.length);

// Pass 1 — no sheets
const r1 = parseHTMLFromTokens(tokens);
console.log('pass1: nodes=', r1.nodes.length, 'scripts=', r1.scripts.length,
            'styles=', r1.styles.length, 'links=', r1.styleLinks.length);

// Collect inline styles like the browser does
let sheets = [];
for (const s of r1.styles) sheets = sheets.concat(parseStylesheet(s));
// Also load external CSS if provided as argv[3]
if (process.argv[3]) {
  const css = readFileSync(process.argv[3], 'utf8');
  sheets = sheets.concat(parseStylesheet(css));
}
console.log('total rules:', sheets.length);
const idx = sheets.length ? buildSheetIndex(sheets) : null;

// Pass 2 — honour display:none
const r2 = parseHTMLFromTokens(tokens, sheets, idx, false);
console.log('pass2(honor): nodes=', r2.nodes.length);

// Pass 2 — ignore display:none
const r3 = parseHTMLFromTokens(tokens, sheets, idx, true);
console.log('pass2(ignore): nodes=', r3.nodes.length);

// Show first 15 visible text snippets from the ignore-mode parse
function textOf(n, out) {
  if (out.length >= 15) return;
  if (n.spans) for (const sp of n.spans) {
    const t = (sp.text || '').trim();
    if (t) { out.push(t.slice(0, 60)); if (out.length >= 15) return; }
  }
  if (n.children) for (const c of n.children) textOf(c, out);
}
const texts = [];
for (const n of r3.nodes) { textOf(n, texts); if (texts.length >= 15) break; }
console.log('ignore-mode visible text:', JSON.stringify(texts, null, 1));

const texts2 = [];
for (const n of r2.nodes) { textOf(n, texts2); if (texts2.length >= 15) break; }
console.log('honor-mode visible text:', JSON.stringify(texts2, null, 1));

// ── Layout stage ─────────────────────────────────────────────────────────────
const { layoutNodes } = await import('../build/js/apps/browser/layout.js');
for (const [label, rr] of [['honor', r2], ['ignore', r3]]) {
  try {
    const lr = layoutNodes(rr.nodes, rr.widgets, 1024);
    let textLines = 0, maxY = 0, firstTexts = [];
    for (const ln of lr.lines) {
      let t = '';
      for (const sp of (ln.nodes || [])) t += (sp.text || '');
      if (t.trim()) {
        textLines++;
        if (firstTexts.length < 10 && ln.y < 3000) firstTexts.push(ln.y + ': ' + t.trim().slice(0, 50));
      }
      if (ln.y > maxY) maxY = ln.y;
    }
    console.log(`layout(${label}): lines=${lr.lines.length} textLines=${textLines} maxY=${maxY} widgets=${lr.widgets.length}`);
    console.log(`layout(${label}) first text lines:`, JSON.stringify(firstTexts, null, 1));
    // Dump text colors of the first 12 non-empty spans (white-on-white check)
    const colors = [];
    for (const ln of lr.lines) {
      for (const sp of (ln.nodes || [])) {
        const t = (sp.text || '').trim();
        if (t && colors.length < 12) {
          colors.push(t.slice(0, 20) + ' -> color=0x' + ((sp.color ?? 0) >>> 0).toString(16));
        }
      }
      if (colors.length >= 12) break;
    }
    console.log(`layout(${label}) span colors:`, JSON.stringify(colors, null, 1));
    // overflow:hidden clip boxes — degenerate ones clip ALL following content
    const clips = [];
    for (const ln of lr.lines) {
      const d = ln.boxDeco;
      if (d && d.overflowHidden) {
        clips.push(`y=${ln.y} x=${d.x} w=${d.w} h=${d.h}`);
      }
    }
    console.log(`layout(${label}) overflowHidden boxes (${clips.length}):`, JSON.stringify(clips.slice(0, 12), null, 1));
  } catch (e) {
    console.log(`layout(${label}) THREW:`, String(e).slice(0, 300));
  }
}
