/**
 * stylesheet.ts — CSS rule parser + selector matcher + cascade
 *
 * Handles:
 *  - Parsing <style> block text into CSSRule[]
 *  - Selector specificity calculation
 *  - Matching simple selectors against element descriptors (tag, id, classes)
 *  - Computing final CSSProps for an element given ordered sheet rules + inline style
 *
 * Selector subset implemented (rightmost simple selector only for combinators):
 *   * element .class #id element.class element#id .a.b [attr] [attr=val]
 *   Descendant ( ) and child (>) combinators: rightmost part matched (approximation)
 *   Grouped selectors: comma-split, each part evaluated independently
 *
 * Properties supported (superset of css.ts parseInlineStyle):
 *   color, background-color, background, font-weight, font-style, text-decoration,
 *   text-align, display, visibility, margin, padding, border, width, max-width,
 *   height, line-height, font-size, list-style-type, opacity
 */

import type { CSSProps } from './types.js';
import { parseCSSColor, parseInlineStyle, registerCSSVarBlock, resolveCSSVars, resetCSSVars } from './css.js';

export { resetCSSVars };

// ── Public types ──────────────────────────────────────────────────────────────

export interface CSSRule {
  sels:  string[];  // selector strings (post comma-split)
  props: CSSProps;
  spec:  number;    // specificity (for cascade ordering). 0xAABBCC
}

// ── Specificity ───────────────────────────────────────────────────────────────

/**
 * Compute the specificity of a SINGLE simple-selector string (no commas).
 * Approximation: we parse the rightmost compound selector.
 *
 *  A  = # of ID selectors       (×0x10000)
 *  B  = # of class/attr/pseudo  (×0x100)
 *  C  = # of type/element       (×0x1)
 */
export function selectorSpecificity(sel: string): number {
  // Get the rightmost compound selector (split on descendant/child/sibling)
  var parts = sel.split(/[\s>+~]+/);
  var last  = parts[parts.length - 1] || '';
  var a = 0, b = 0, c = 0;
  // Count ID selectors
  var ids = last.match(/#[^.#[\s:]+/g);
  if (ids) a += ids.length;
  // Count class, attribute, pseudo-class selectors
  var clss = last.match(/\.[^.#[\s:]+|\[[^\]]+\]|:(?!:)[^.#[\s:]+/g);
  if (clss) b += clss.length;
  // Count type selectors (non-* identifiers at start)
  if (last && last !== '*' && /^[a-zA-Z]/.test(last)) c++;
  return (a << 16) | (b << 8) | c;
}

// ── Selector matching (single element, no ancestor context) ───────────────────

/**
 * Check if a single selector string (no commas) matches an element described by:
 *  tag      — lowercase tag name (e.g. 'p', 'a', 'div')
 *  id       — element id attribute value
 *  cls      — array of class names from className
 *  attrs    — map of other attributes (for [attr=val])
 *
 * Combinators (space, >, +, ~) are handled by only matching the rightmost
 * compound selector — a deliberate approximation that covers the majority of
 * rule matches without requiring ancestor context.
 */
export function matchesSingleSel(
  tag: string, id: string, cls: string[],
  attrs: Map<string, string>,
  sel: string,
): boolean {
  sel = sel.trim();
  if (!sel) return false;

  // Grab the rightmost compound selector after any combinator
  var right = sel.split(/\s*[\s>+~]\s+|\s*[>+~]\s*/)[sel.split(/\s*[\s>+~]\s+|\s*[>+~]\s*/).length - 1]!.trim();

  return matchesCompound(tag, id, cls, attrs, right);
}

/**
 * Match a compound selector string (no combinators) against element descriptors.
 * E.g.: 'div.foo#bar[href]'
 */
function matchesCompound(
  tag: string, id: string, cls: string[],
  attrs: Map<string, string>,
  compound: string,
): boolean {
  if (!compound || compound === '*') return true;

  var rest = compound;

  // Extract type selector at start (letter/digit chars up to ./#/[/:)
  var typeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (typeMatch) {
    if (typeMatch[1].toLowerCase() !== tag) return false;
    rest = rest.slice(typeMatch[1].length);
  }

  // Match remaining simple selectors
  while (rest.length > 0) {
    if (rest[0] === '#') {
      // ID selector
      var idM = rest.match(/^#([^.#[:\s]+)/);
      if (!idM) return false;
      if (id !== idM[1]) return false;
      rest = rest.slice(idM[0].length);
    } else if (rest[0] === '.') {
      // Class selector
      var clM = rest.match(/^\.([^.#[:\s]+)/);
      if (!clM) return false;
      if (!cls.includes(clM[1])) return false;
      rest = rest.slice(clM[0].length);
    } else if (rest[0] === '[') {
      // Attribute selector [name] [name=val] [name^=val] etc
      var atM = rest.match(/^\[([^\]]+)\]/);
      if (!atM) return false;
      var atExpr = atM[1]!;
      var eqM    = atExpr.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)([~|^$*]?=)?(.+)?$/);
      if (eqM) {
        var atName = eqM[1]!.toLowerCase().trim();
        var atOp   = eqM[2] || '';
        var atVal  = (eqM[3] || '').replace(/^['"]|['"]$/g, '');
        var elVal  = attrs.get(atName) ?? (atName === 'id' ? id : atName === 'class' ? cls.join(' ') : '');
        if (atOp === '') {
          if (!attrs.has(atName) && atName !== 'id' && atName !== 'class') return false;
        } else if (atOp === '=')  { if (elVal !== atVal) return false; }
        else if  (atOp === '~=') { if (!elVal.split(/\s+/).includes(atVal)) return false; }
        else if  (atOp === '^=') { if (!elVal.startsWith(atVal)) return false; }
        else if  (atOp === '$=') { if (!elVal.endsWith(atVal))   return false; }
        else if  (atOp === '*=') { if (!elVal.includes(atVal))   return false; }
      }
      rest = rest.slice(atM[0].length);
    } else if (rest[0] === ':') {
      // Pseudo-class — skip (we don't track DOM state like :hover)
      var psM = rest.match(/^:+([a-zA-Z-]+)(?:\([^)]*\))?/);
      if (psM) rest = rest.slice(psM[0].length);
      else     return false;
    } else {
      break;
    }
  }
  return true;
}

// ── CSS property parser (superset of parseInlineStyle) ────────────────────────

/**
 * Parse a CSS declaration block string (the part inside `{}`) into CSSProps.
 */
export function parseDeclBlock(block: string): CSSProps {
  return parseInlineStyle(block);
}

// ── Stylesheet tokeniser ──────────────────────────────────────────────────────

/**
 * Parse a CSS stylesheet text (from a <style> block or external .css file)
 * into an ordered array of CSSRule objects.
 *
 * Handles:
 *  - Rule blocks: `selector { declarations }`
 *  - At-rules skipped: @media, @keyframes, @import, @charset, @font-face
 *  - Comments removed: `/* ... *\/`
 *  - Nested @media blocks: descent once (one level of nesting)
 */
export function parseStylesheet(css: string): CSSRule[] {
  var rules: CSSRule[] = [];

  // Remove comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove @charset, @import, @namespace
  css = css.replace(/@(?:charset|import|namespace)[^;]+;/gi, '');

  var i = 0;

  function skipWs(): void { while (i < css.length && css[i] <= ' ') i++; }

  // Read until {, }, @, or end
  function readUntil(stop: string): string {
    var start = i;
    var depth = 0;
    while (i < css.length) {
      var ch = css[i];
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth--; if (depth < 0) depth = 0; i++; continue; }
      if (ch === '"' || ch === "'") {
        var q = ch; i++;
        while (i < css.length && css[i] !== q) {
          if (css[i] === '\\') i++;
          i++;
        }
        i++; continue;
      }
      if (depth === 0 && stop.includes(ch)) break;
      i++;
    }
    return css.slice(start, i).trim();
  }

  while (i < css.length) {
    skipWs();
    if (i >= css.length) break;

    // At-rule
    if (css[i] === '@') {
      i++;
      var atKw = readUntil(' {;').replace(/\s+/g, '').toLowerCase();
      skipWs();
      if (i < css.length && css[i] === ';') { i++; continue; } // @import etc
      if (i < css.length && css[i] === '{') {
        i++;
        // For @media — parse inner rules
        if (atKw.startsWith('media') || atKw.startsWith('supports') || atKw.startsWith('layer')) {
          // Read inner content (handles one level of nesting)
          var depth2 = 1;
          var start2 = i;
          while (i < css.length && depth2 > 0) {
            if (css[i] === '{') depth2++;
            else if (css[i] === '}') depth2--;
            i++;
          }
          var inner = css.slice(start2, i - 1);
          // Recursively parse inner rules (e.g. @media body rules)
          var innerRules = parseStylesheet(inner);
          rules.push(...innerRules);
        } else {
          // Skip other at-rule blocks (@keyframes, @font-face, etc.)
          var d3 = 1;
          while (i < css.length && d3 > 0) {
            if (css[i] === '{') d3++;
            else if (css[i] === '}') d3--;
            i++;
          }
        }
      }
      continue;
    }

    // Regular rule: selector(s) { declarations }
    var selText = readUntil('{};');
    if (i >= css.length || css[i] !== '{') { i++; continue; }
    i++; // consume {
    var declBlock = readUntil('}');
    if (i < css.length && css[i] === '}') i++; // consume }

    selText = selText.trim();
    if (!selText || !declBlock.trim()) continue;

    var props = parseDeclBlock(declBlock);
    // Split by comma (but not inside parens/strings)
    var sels  = splitSelectors(selText);

    // Compute max specificity across comma-grouped selectors
    var spec = 0;
    for (var si = 0; si < sels.length; si++) {
      var s2 = selectorSpecificity(sels[si]!);
      if (s2 > spec) spec = s2;
    }

    rules.push({ sels, props, spec });
  }

  return rules;
}

/** Split a selector text on commas, but not inside parentheses. */
function splitSelectors(sel: string): string[] {
  var parts: string[] = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < sel.length; i++) {
    if (sel[i] === '(') depth++;
    else if (sel[i] === ')') depth--;
    else if (sel[i] === ',' && depth === 0) {
      var p = sel.slice(start, i).trim();
      if (p) parts.push(p);
      start = i + 1;
    }
  }
  var last = sel.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

// ── Cascade ───────────────────────────────────────────────────────────────────

/**
 * Compute the cascaded CSSProps for an element, given:
 *  - tag, id, cls  — element descriptor
 *  - attrs         — element attribute map (for [attr=val] selectors)
 *  - inherited     — inherited CSSProps from parent (color, font-weight etc.)
 *  - sheets        — sorted stylesheet rules (in source order)
 *  - inlineStyle   — inline style="" attribute string (highest priority)
 *
 * Returns merged CSSProps from: UA defaults → sheet rules (spec-sorted) → inline
 */
export function computeElementStyle(
  tag:         string,
  id:          string,
  cls:         string[],
  attrs:       Map<string, string>,
  inherited:   CSSProps,
  sheets:      CSSRule[],
  inlineStyle: string,
): CSSProps {
  // Start with inherited properties
  var result: CSSProps = {
    color:  inherited.color,
    bold:   inherited.bold,
    italic: inherited.italic,
    align:  inherited.align,
  };

  // Collect matching rules
  var matches: { props: CSSProps; spec: number; order: number }[] = [];
  for (var ri = 0; ri < sheets.length; ri++) {
    var rule = sheets[ri]!;
    for (var si = 0; si < rule.sels.length; si++) {
      if (matchesSingleSel(tag, id, cls, attrs, rule.sels[si]!)) {
        matches.push({ props: rule.props, spec: rule.spec, order: ri });
        break;
      }
    }
  }

  // Sort by specificity then source order
  matches.sort((a, b) => a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);

  // Apply in cascade order (lower specificity first, overridden by higher)
  for (var mi = 0; mi < matches.length; mi++) {
    mergeProps(result, matches[mi]!.props);
  }

  // Inline style wins over everything
  if (inlineStyle) {
    mergeProps(result, parseInlineStyle(inlineStyle));
  }

  return result;
}

function mergeProps(target: CSSProps, src: CSSProps): void {
  if (src.color        !== undefined) target.color        = src.color;
  if (src.bgColor      !== undefined) target.bgColor      = src.bgColor;
  if (src.bold         !== undefined) target.bold         = src.bold;
  if (src.italic       !== undefined) target.italic       = src.italic;
  if (src.underline    !== undefined) target.underline    = src.underline;
  if (src.strike       !== undefined) target.strike       = src.strike;
  if (src.align        !== undefined) target.align        = src.align;
  if (src.hidden       !== undefined) target.hidden       = src.hidden;
  if (src.float        !== undefined) target.float        = src.float;
  if (src.display      !== undefined) target.display      = src.display;
  if (src.paddingLeft  !== undefined) target.paddingLeft  = src.paddingLeft;
  if (src.paddingRight !== undefined) target.paddingRight = src.paddingRight;
  if (src.paddingTop   !== undefined) target.paddingTop   = src.paddingTop;
  if (src.paddingBottom !== undefined) target.paddingBottom = src.paddingBottom;
  if (src.marginTop    !== undefined) target.marginTop    = src.marginTop;
  if (src.marginBottom !== undefined) target.marginBottom = src.marginBottom;
  if (src.width        !== undefined) target.width        = src.width;
  if (src.maxWidth     !== undefined) target.maxWidth     = src.maxWidth;
  if (src.fontScale    !== undefined) target.fontScale    = src.fontScale;
}
