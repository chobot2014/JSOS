#!/usr/bin/env node
/**
 * embed-js.js
 * Embeds build/bundle.js into src/kernel/embedded_js.h as a C string literal.
 * Cross-platform. Run via: npm run embed:js
 */

const fs = require('fs');
const path = require('path');

const BUNDLE  = path.join(__dirname, '..', 'build', 'bundle.js');
const HEADER  = path.join(__dirname, '..', 'src', 'kernel', 'embedded_js.h');

if (!fs.existsSync(BUNDLE)) {
  console.error('Error: build/bundle.js not found. Run "npm run bundle" first.');
  process.exit(1);
}

console.log('Embedding build/bundle.js into src/kernel/embedded_js.h ...');

const js = fs.readFileSync(BUNDLE, 'utf8');

// Escape the JS source into a C string
// Each line becomes "...\n" so QuickJS gets one big string
const lines = js.split('\n');
const escaped = lines.map(line => {
  // Escape backslashes first, then double-quotes
  const e = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    // Break C trigraph sequences (??=→# ??/→\ ??(→[ etc.)
    // by inserting \? between the two ? characters.
    // In C, \? is the escape for '?' so ?\?= compiles back to ??= at runtime
    // but the preprocessor never sees the 3-char trigraph sequence ??=.
    .replace(/\?\?/g, '?\\?');
  return '"' + e + '\\n"';
});

const header =
`#ifndef EMBEDDED_JS_H
#define EMBEDDED_JS_H

/* Auto-generated — do not edit.  Regenerate with: npm run embed:js */
static const char* embedded_js_code =
${escaped.join('\n')}
;

#endif /* EMBEDDED_JS_H */
`;

fs.writeFileSync(HEADER, header, 'utf8');
console.log(`Done. ${lines.length} lines embedded (${(fs.statSync(HEADER).size / 1024).toFixed(1)} KB).`);
