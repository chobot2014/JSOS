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
import { parseCSSColor, parseInlineStyle, registerCSSVarBlock, resolveCSSVars, resetCSSVars, setViewport, getViewport } from './css.js';
import { buildRuleIndex, candidateRules, type RuleIndex } from './cache.js';

// ── CSS match result cache (per-element across same sheets) ──────────────────
// Caches the sorted list of matched rules for an element identified by
// tag+id+cls+inlineStyle+sheetsLength.  Sheets length is used as a proxy for
// "same stylesheet version" — if sheets grows (new CSS fetched), the cache key
// changes and entries are naturally invalidated.
//
// Trade-off: cache entries per unique element signature, bounded at 8192.
// Flushed whenever sheets change (buildSheetIndex called).
// Hit rate is very high on rerenders where the DOM is stable.
/** Pre-merged CSS match result — avoids re-iterating matches on cache hit */
interface CSSMatchEntry {
  normalMerged: CSSProps;            // all normal matches pre-merged
  importantProps: CSSProps[] | null; // matches with !important (rare)
  hasKeywords: boolean;              // any match has _inherit/_initial
  matchProps?: CSSProps[];           // individual match props (only when hasKeywords)
}
const _cssMatchCache = new Map<string, CSSMatchEntry>();
var _cssMatchHits = 0;
var _cssMatchTotal = 0;

// ── Module-level reusable buffers for cache-miss match collection ────────────
// Avoids allocating 3 arrays per cache miss (153 misses × 3 = 459 allocs saved
// per render).  Safe because computeElementStyle is non-recursive.
var _gmProps: CSSProps[] = [];
var _gmSpec:  number[]   = [];
var _gmOrder: number[]   = [];
var _gmLen   = 0;

/** Shared singleton for empty getPseudoContent results — avoids alloc per call */
var _EMPTY_PSEUDO: { before: string; after: string } = { before: '', after: '' };


export { resetCSSVars, setViewport };

/** Clear the CSS match result cache (call on navigation / stylesheet change). */
export function flushCSSMatchCache(): void {
  _cssMatchCache.clear();
  _cssMatchHits  = 0;
  _cssMatchTotal = 0;
  _parsedCompoundCache.clear();
  _declBlockCache.clear();  // CSS vars change across pages, invalidates cached props
}

/** Return CSS match cache stats: [hits, total, cacheSize] */
export function getCSSMatchCacheStats(): [number, number, number] {
  return [_cssMatchHits, _cssMatchTotal, _cssMatchCache.size];
}

export type { RuleIndex };

// ── Public types ──────────────────────────────────────────────────────────────

export interface CSSRule {
  sels:  string[];  // selector strings (post comma-split)
  props: CSSProps;
  spec:  number;    // specificity (for cascade ordering). 0xAABBCC
  order: number;    // source order index (set after parseStylesheet, avoids indexOf O(n²))
  parsedSels?: ParsedSel[];  // pre-parsed selectors — set by parseStylesheet for hot-path matching
  _stamp?: number;  // dedup stamp for candidateRules (avoids Set allocation)
  /** Pre-computed pseudo-element info for content rules (avoids regex in getPseudoContent hot path) */
  _pseudoInfos?: Array<{ pseudo: 'before' | 'after'; hostParsed: ParsedSel } | null>;
  /** True if ALL selectors require :hover/:focus/:active — skip during static layout */
  _stateOnly?: boolean;
  /** Rightmost compound tag (if any) for fast pre-rejection in matching loop */
  _reqTag?: string;
  /** ALL classes from rightmost compound for multi-class pre-rejection */
  _reqClasses?: string[];
  /** Rightmost compound ID (if any) for fast pre-rejection */
  _reqId?: string;
  /** True if single-selector, single-compound, no pseudos, no attrs —
   *  when all pre-checks pass, skip matchesParsedSel entirely */
  _simpleMatch?: boolean;
}

// ── Pre-parsed selector types (no regex at match time) ───────────────────────

/** A parsed attribute predicate: [name], [name=val], [name^=val], etc. */
interface ParsedAttr { name: string; op: string; val: string; }

/** A parsed pseudo-class/pseudo-element simple selector. */
interface ParsedPseudo {
  name: string;
  arg:  string;
  /** For :not/:is/:where — pre-parsed argument selectors */
  argParsed?: ParsedCompound[];
}

/**
 * A pre-parsed compound selector (no combinators).
 * Null values mean "accept any" (wildcard).
 */
interface ParsedCompound {
  tag:     string | null;   // lowercase element type; null = accept any (*)
  ids:     string[];        // required #id values (usually 0 or 1)
  classes: string[];        // required .class names
  attrs:   ParsedAttr[];    // required attribute predicates
  pseudos: ParsedPseudo[];  // pseudo-class/pseudo-element tests
}

/**
 * A pre-parsed single selector (no commas).
 * compounds[0] is the rightmost (subject element) compound.
 * combinators[i] is the combinator to the left of compounds[i+1].
 */
interface ParsedSel {
  compounds:    ParsedCompound[];
  combinators:  string[];   // same length as compounds - 1
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
  return _specFromParsed(_parseSel(sel.trim()));
}

/** Compute specificity from pre-parsed selector data (no regex). */
function _specFromParsed(ps: ParsedSel): number {
  var a = 0, b = 0, c = 0;
  for (var ci = 0; ci < ps.compounds.length; ci++) {
    var comp = ps.compounds[ci]!;
    a += comp.ids.length;
    b += comp.classes.length + comp.attrs.length;
    for (var pi = 0; pi < comp.pseudos.length; pi++) {
      var ps2 = comp.pseudos[pi]!;
      var pn = ps2.name;
      // Pseudo-elements add to c, pseudo-classes add to b
      if (pn === 'before' || pn === 'after' || pn === 'first-line' || pn === 'first-letter') { c++; }
      // :where() contributes ZERO specificity (CSS Selectors Level 4)
      else if (pn === 'where') { /* no specificity contribution */ }
      // :not(), :is(), :has() — specificity = max of their arguments, not +1
      else if ((pn === 'not' || pn === 'is' || pn === 'has') && ps2.argParsed && ps2.argParsed.length > 0) {
        var maxArgSpec = 0;
        for (var ai = 0; ai < ps2.argParsed.length; ai++) {
          var argSel: ParsedSel = { compounds: [ps2.argParsed[ai]!], combinators: [] };
          var argS = _specFromParsed(argSel);
          if (argS > maxArgSpec) maxArgSpec = argS;
        }
        a += (maxArgSpec >> 16) & 0xFF;
        b += (maxArgSpec >> 8) & 0xFF;
        c += maxArgSpec & 0xFF;
      }
      else { b++; }
    }
    if (comp.tag !== null) c++;
  }
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
/** Element context for combinator matching (parent-first, outermost last). */
export interface AncestorEl {
  tag:   string;
  id:    string;
  cls:   string[];
  attrs: Map<string, string>;
  /** Sibling index (0-based) among parent's element children, -1 if unknown */
  siblingIndex?: number;
  /** Total sibling count (parent's element child count), -1 if unknown */
  siblingCount?: number;
}

/**
 * Split a selector string into compound parts and their combinators.
 * Correctly skips paren-content (e.g. :not(.foo > div)).
 * Returns { parts, combinators } where combinators[i] is between parts[i] and parts[i+1].
 */
const _selectorPartsCache = new Map<string, { parts: string[]; combinators: string[] }>();
function _parseSelectorParts(sel: string): { parts: string[]; combinators: string[] } {
  var cached = _selectorPartsCache.get(sel);
  if (cached) return cached;
  var parts: string[] = [];
  var combinators: string[] = [];
  var depth = 0;
  var curStart = 0;  // track substring start instead of building char-by-char
  var cur = '';
  var i = 0;
  // charCodeAt constants for combinator detection
  var _GT = 62, _PLUS = 43, _TILDE = 126, _SP = 32, _LP2 = 40, _RP2 = 41;
  while (i < sel.length) {
    var chc = sel.charCodeAt(i);
    if (chc === _LP2) { depth++; i++; continue; }
    if (chc === _RP2) { depth--; i++; continue; }
    if (depth > 0) { i++; continue; }
    if (chc === _GT || chc === _PLUS || chc === _TILDE) {
      var flushed = (cur + sel.slice(curStart, i)).trim();
      if (flushed) parts.push(flushed);
      combinators.push(sel[i]!);
      cur = ''; i++; curStart = i;
      while (i < sel.length && sel.charCodeAt(i) === _SP) i++;
      curStart = i;
      continue;
    }
    if (chc === _SP) {
      // peek past spaces — if next non-space is >, + or ~ that combinator wins
      var j = i + 1;
      while (j < sel.length && sel.charCodeAt(j) === _SP) j++;
      if (j < sel.length) {
        var nextC = sel.charCodeAt(j);
        if (nextC === _GT || nextC === _PLUS || nextC === _TILDE) {
          var flushed2 = (cur + sel.slice(curStart, i)).trim();
          if (flushed2) parts.push(flushed2);
          cur = ''; i = j; curStart = j; continue;
        }
      }
      // Otherwise this is a descendant combinator ' '
      var flushed3 = (cur + sel.slice(curStart, i)).trim();
      if (flushed3) { parts.push(flushed3); combinators.push(' '); }
      cur = ''; i = j; curStart = j; continue;
    }
    i++;
  }
  var finalPart = (cur + sel.slice(curStart, i)).trim();
  if (finalPart) parts.push(finalPart);
  var result = { parts, combinators };
  if (_selectorPartsCache.size < 10000) _selectorPartsCache.set(sel, result);
  return result;
}

/**
 * Evaluate an An+B expression (e.g. 'odd', 'even', '3n+1', '5', '2n')
 * against a 1-based child position.
 */
function _matchesNth(expr: string, pos: number): boolean {
  expr = expr.trim().toLowerCase();
  if (expr === 'odd') return pos % 2 === 1;
  if (expr === 'even') return pos % 2 === 0;
  // Parse An+B form
  var m = expr.match(/^([+-]?\d*)?n\s*([+-]\s*\d+)?$/);
  if (m) {
    var a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1]!, 10);
    var b = m[2] ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
    if (a === 0) return pos === b;
    // pos = a*n + b → n = (pos - b) / a, n >= 0 and integer
    var n = (pos - b) / a;
    return n >= 0 && Number.isInteger(n);
  }
  // Plain number (e.g. "3")
  var plain = parseInt(expr, 10);
  if (!isNaN(plain)) return pos === plain;
  return true; // fallback: optimistic
}

// ── Pre-parsed selector compiler ──────────────────────────────────────────────
// Converts compound selector strings into ParsedCompound structs ONCE at
// stylesheet parse time.  At match time we only do simple string comparisons —
// no regex, no repeated string splits.  This eliminates the JIT hotspot that
// was causing QuickJS stack overflow on 800+ rule sheets.

const _parsedCompoundCache = new Map<string, ParsedCompound>();

/**
 * Parse a compound selector string into a ParsedCompound struct.
 * Called once per unique compound string at parseStylesheet time.
 * Regex-free: uses charCodeAt for all token scanning.
 */
function _parseCompound(compound: string): ParsedCompound {
  var cached = _parsedCompoundCache.get(compound);
  if (cached) return cached;

  var tag: string | null = null;
  var ids: string[] = [];
  var classes: string[] = [];
  var attrs: ParsedAttr[] = [];
  var pseudos: ParsedPseudo[] = [];

  if (!compound || compound === '*') {
    var result0: ParsedCompound = { tag: null, ids, classes, attrs, pseudos };
    _parsedCompoundCache.set(compound, result0);
    return result0;
  }

  var i = 0;
  var n = compound.length;

  // Helper: is char an ident char (a-z, A-Z, 0-9, -, _)?
  function _isIdent(cc: number): boolean {
    return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) ||
           (cc >= 48 && cc <= 57) || cc === 45 || cc === 95;
  }
  // Read ident token starting at i (returns lowercased)
  function _readIdent(): string {
    var s = i;
    while (i < n && _isIdent(compound.charCodeAt(i))) i++;
    return compound.slice(s, i).toLowerCase();
  }
  // Read until boundary char (.#[:space)
  function _readUntilBound(): string {
    var s = i;
    while (i < n) {
      var cc = compound.charCodeAt(i);
      if (cc === 46 /*.*/ || cc === 35 /*#*/ || cc === 91 /*[*/ ||
          cc === 58 /*:*/ || cc <= 32) break;
      i++;
    }
    return compound.slice(s, i);
  }

  // Type selector at start (a-zA-Z)
  var firstCC = compound.charCodeAt(0);
  if ((firstCC >= 97 && firstCC <= 122) || (firstCC >= 65 && firstCC <= 90)) {
    tag = _readIdent();
    if (tag === '*') tag = null; // already handled above but defensive
  } else if (firstCC === 42 /* * */) {
    i++; // skip *
  }

  // Parse remaining simple selectors iteratively
  while (i < n) {
    var ch = compound.charCodeAt(i);
    if (ch === 35 /* # */) {
      i++; // skip #
      var idVal = _readUntilBound();
      if (idVal) ids.push(idVal);
    } else if (ch === 46 /* . */) {
      i++; // skip .
      var clVal = _readUntilBound();
      if (clVal) classes.push(clVal);
    } else if (ch === 91 /* [ */) {
      i++; // skip [
      var closeBracket = compound.indexOf(']', i);
      if (closeBracket < 0) break;
      var atExpr = compound.slice(i, closeBracket);
      i = closeBracket + 1;
      // Parse attr[op[=val]]
      var ai2 = 0;
      var atName = '';
      while (ai2 < atExpr.length && _isIdent(atExpr.charCodeAt(ai2))) ai2++;
      atName = atExpr.slice(0, ai2).toLowerCase().trim();
      var atOp = '';
      var atVal = '';
      if (ai2 < atExpr.length) {
        var opStart = ai2;
        while (ai2 < atExpr.length && atExpr.charCodeAt(ai2) !== 61 /* = */) ai2++;
        if (ai2 < atExpr.length) {
          atOp = atExpr.slice(opStart, ai2 + 1); // includes =
          ai2++;
          atVal = atExpr.slice(ai2).trim();
          // Strip quotes
          if (atVal.length >= 2) {
            var q = atVal.charCodeAt(0);
            if ((q === 34 || q === 39) && atVal.charCodeAt(atVal.length - 1) === q) {
              atVal = atVal.slice(1, -1);
            }
          }
        }
      }
      if (atName) attrs.push({ name: atName, op: atOp, val: atVal });
    } else if (ch === 58 /* : */) {
      i++; // skip :
      if (i < n && compound.charCodeAt(i) === 58) i++; // skip :: (pseudo-element)
      var psName = _readIdent();
      var psArg = '';
      if (i < n && compound.charCodeAt(i) === 40 /* ( */) {
        i++; // skip (
        // Read balanced parens
        var depth = 1;
        var argStart = i;
        while (i < n && depth > 0) {
          var pc = compound.charCodeAt(i);
          if (pc === 40) depth++;
          else if (pc === 41) depth--;
          if (depth > 0) i++;
        }
        psArg = compound.slice(argStart, i);
        if (i < n) i++; // skip )
      }
      // Pre-parse :not/:is/:where argument into compounds
      var argParsed: ParsedCompound[] | undefined;
      if ((psName === 'not' || psName === 'is' || psName === 'where') && psArg) {
        argParsed = psArg.split(',').map(s => _parseCompound(s.trim()));
      }
      pseudos.push({ name: psName, arg: psArg, argParsed });
    } else {
      break; // unknown token — stop
    }
  }

  var result: ParsedCompound = { tag, ids, classes, attrs, pseudos };
  if (_parsedCompoundCache.size < 20000) _parsedCompoundCache.set(compound, result);
  return result;
}

/**
 * Parse a full selector (may contain combinators) into a ParsedSel struct.
 * The rightmost compound is compounds[0]; each subsequent compound is an ancestor.
 */
function _parseSel(sel: string): ParsedSel {
  var parsed = _parseSelectorParts(sel.trim());
  var compounds: ParsedCompound[] = [];
  var combinators: string[] = [];
  // parts[last] is the rightmost (subject), parts[0] is the outermost ancestor
  for (var pi = parsed.parts.length - 1; pi >= 0; pi--) {
    compounds.push(_parseCompound(parsed.parts[pi]!));
    if (pi > 0) combinators.push(parsed.combinators[pi - 1]!);
  }
  return { compounds, combinators };
}

/**
 * Pre-parse all selectors in a CSSRule[] and store on rule.parsedSels.
 * Called once per stylesheet at parse time.
 */
export function preParseSelectorRules(rules: CSSRule[]): void {
  for (var ri = 0; ri < rules.length; ri++) {
    var rule = rules[ri]!;
    if (!rule.parsedSels) {
      var parsedSels: ParsedSel[] = [];
      for (var si = 0; si < rule.sels.length; si++) {
        parsedSels.push(_parseSel(rule.sels[si]!));
      }
      rule.parsedSels = parsedSels;
    }
  }
}

/**
 * Match a pre-parsed compound selector against element descriptors.
 * No regex — pure property/array comparisons.
 * clsSet is a Set<string> for O(1) lookup; sortedCls is a sorted array for binary search.
 * If both are null, falls back to Array.includes() O(N) scan.
 */
function _matchParsedCompound(
  tag: string, id: string, cls: string[], clsSet: Set<string> | null,
  attrs: Map<string, string>,
  pc: ParsedCompound,
  sibIdx?: number,
  sibCount?: number,
): boolean {
  if (pc.tag !== null && pc.tag !== tag) return false;
  for (var i = 0; i < pc.ids.length; i++) { if (id !== pc.ids[i]) return false; }
  if (pc.classes.length > 0) {
    if (clsSet) {
      for (var i = 0; i < pc.classes.length; i++) { if (!clsSet.has(pc.classes[i]!)) return false; }
    } else {
      for (var i = 0; i < pc.classes.length; i++) { if (!cls.includes(pc.classes[i]!)) return false; }
    }
  }
  for (var i = 0; i < pc.attrs.length; i++) {
    var a = pc.attrs[i]!;
    var elVal = attrs.get(a.name) ?? (a.name === 'id' ? id : a.name === 'class' ? cls.join(' ') : '');
    if (a.op === '') {
      if (!attrs.has(a.name) && a.name !== 'id' && a.name !== 'class') return false;
    } else if (a.op === '=')  { if (elVal !== a.val) return false; }
    else if  (a.op === '~=') { if (!elVal.split(/\s+/).includes(a.val)) return false; }
    else if  (a.op === '^=') { if (!elVal.startsWith(a.val)) return false; }
    else if  (a.op === '$=') { if (!elVal.endsWith(a.val))   return false; }
    else if  (a.op === '*=') { if (!elVal.includes(a.val))   return false; }
    // R19: [attr|="val"] — matches exact value or value followed by '-' (CSS lang selector)
    else if  (a.op === '|=') { if (elVal !== a.val && !elVal.startsWith(a.val + '-')) return false; }
  }
  for (var i = 0; i < pc.pseudos.length; i++) {
    var ps = pc.pseudos[i]!;
    var pn = ps.name;
    if (pn === 'before' || pn === 'after' || pn === 'first-line' || pn === 'first-letter') {
      // pseudo-elements — match the host element
    } else if (pn === 'hover' || pn === 'focus' || pn === 'active' ||
               pn === 'focus-within' || pn === 'focus-visible') {
      // State pseudo-classes — conservative: during static layout no element
      // is hovered/focused/active.  Returning false eliminates matching of all
      // :hover/:focus/:active rules (e.g. Google has ~20 such rules) which
      // wastes mergeProps work and applies wrong styles.
      return false;
    } else if (pn === 'checked' || pn === 'selected') {
      if (!attrs.has('checked')) return false;
    } else if (pn === 'disabled') {
      if (!attrs.has('disabled')) return false;
    } else if (pn === 'enabled') {
      if (attrs.has('disabled')) return false;
    } else if (pn === 'required') {
      if (!attrs.has('required')) return false;
    } else if (pn === 'optional') {
      if (attrs.has('required')) return false;
    } else if (pn === 'placeholder-shown') {
      if (!attrs.has('placeholder')) return false;
    } else if (pn === 'link' || pn === 'any-link') {
      if (tag !== 'a' && tag !== 'area' && tag !== 'link') return false;
    } else if (pn === 'visited') {
      // conservative miss
    } else if (pn === 'first-child') {
      if (sibIdx !== undefined && sibIdx !== 0) return false;
    } else if (pn === 'last-child') {
      if (sibIdx !== undefined && sibCount !== undefined && sibIdx !== sibCount - 1) return false;
    } else if (pn === 'only-child') {
      if (sibCount !== undefined && sibCount !== 1) return false;
    } else if (pn === 'nth-child') {
      if (sibIdx !== undefined && ps.arg) {
        if (!_matchesNth(ps.arg, sibIdx + 1)) return false;
      }
    } else if (pn === 'nth-last-child') {
      if (sibIdx !== undefined && sibCount !== undefined && ps.arg) {
        if (!_matchesNth(ps.arg, sibCount - sibIdx)) return false;
      }
    } else if (pn === 'first-of-type' || pn === 'last-of-type' || pn === 'only-of-type' ||
               pn === 'nth-of-type' || pn === 'nth-last-of-type') {
      // optimistic match
    } else if (pn === 'not' && ps.argParsed) {
      for (var ni = 0; ni < ps.argParsed.length; ni++) {
        if (_matchParsedCompound(tag, id, cls, clsSet, attrs, ps.argParsed[ni]!)) return false;
      }
    } else if ((pn === 'is' || pn === 'where') && ps.argParsed) {
      var anyMatch = false;
      for (var ni = 0; ni < ps.argParsed.length; ni++) {
        if (_matchParsedCompound(tag, id, cls, clsSet, attrs, ps.argParsed[ni]!)) { anyMatch = true; break; }
      }
      if (!anyMatch) return false;
    } else if (pn === 'root') {
      if (tag !== 'html') return false;
    }
    // unknown pseudo-classes: optimistic pass
  }
  return true;
}

export function matchesSingleSel(
  tag: string, id: string, cls: string[],
  attrs: Map<string, string>,
  sel: string,
  ancestors?: AncestorEl[],
  sibIdx?: number,   // 0-based index among parent's element children
  sibCount?: number, // total element children of parent
): boolean {
  sel = sel.trim();
  if (!sel) return false;
  // Use pre-parsed form — eliminates regex from hot matching path
  return matchesParsedSel(tag, id, cls, attrs, _parseSel(sel), ancestors, sibIdx, sibCount);
}

/**
 * Match a pre-parsed selector against element descriptors.
 * No regex — pure struct field comparisons.
 */
export function matchesParsedSel(
  tag: string, id: string, cls: string[],
  attrs: Map<string, string>,
  ps: ParsedSel,
  ancestors?: AncestorEl[],
  sibIdx?: number,
  sibCount?: number,
  clsSet?: Set<string> | null,
): boolean {
  var compounds   = ps.compounds;
  var combinators = ps.combinators;
  if (compounds.length === 0) return false;

  // Rightmost compound must match the subject element
  if (!_matchParsedCompound(tag, id, cls, clsSet ?? null, attrs, compounds[0]!, sibIdx, sibCount)) return false;
  if (compounds.length === 1) return true;

  // If no ancestor context, fall back to optimistic pass
  if (!ancestors || ancestors.length === 0) return true;

  // Walk right-to-left through the combinator chain
  var ancIdx = 0;
  for (var pi = 1; pi < compounds.length; pi++) {
    var comb = combinators[pi - 1]!;
    var reqComp = compounds[pi]!;
    if (comb === '>') {
      if (ancIdx >= ancestors.length) return false;
      var pa = ancestors[ancIdx]!;
      if (!_matchParsedCompound(pa.tag, pa.id, pa.cls, null, pa.attrs, reqComp)) return false;
      ancIdx++;
    } else if (comb === ' ') {
      // Fast pre-check: if the required compound specifies a tag, scan ancestor
      // tags first before doing full compound matching at each level.
      var reqTag = reqComp.tag;
      if (reqTag !== null) {
        var found = false;
        while (ancIdx < ancestors.length) {
          var an = ancestors[ancIdx]!;
          ancIdx++;
          if (an.tag === reqTag && _matchParsedCompound(an.tag, an.id, an.cls, null, an.attrs, reqComp)) { found = true; break; }
        }
        if (!found) return false;
      } else {
        var found = false;
        while (ancIdx < ancestors.length) {
          var an = ancestors[ancIdx]!;
          ancIdx++;
          if (_matchParsedCompound(an.tag, an.id, an.cls, null, an.attrs, reqComp)) { found = true; break; }
        }
        if (!found) return false;
      }
    }
    // + and ~ sibling combinators: optimistic pass
  }
  return true;
}

// ── CSS property parser (superset of parseInlineStyle) ────────────────────────

// Cache for parseDeclBlock — many CSS rules share identical declaration blocks.
// Google's ~800 rules have significant duplication (same colors, font, display).
// Bounded to 4096 entries; flushed on navigation via flushDeclBlockCache().
var _declBlockCache = new Map<string, CSSProps>();

export function flushDeclBlockCache(): void { _declBlockCache.clear(); }

/**
 * Parse a CSS declaration block string (the part inside `{}`) into CSSProps.
 * Results are cached by the raw block text.
 */
export function parseDeclBlock(block: string): CSSProps {
  var _cached = _declBlockCache.get(block);
  if (_cached) return _cached;
  var result = parseInlineStyle(block);
  if (_declBlockCache.size < 4096) _declBlockCache.set(block, result);
  return result;
}

// ── Media query evaluator ─────────────────────────────────────────────────────

/**
 * Evaluate a CSS media query condition against current viewport.
 * Supports: min-width, max-width, min-height, max-height, screen, all,
 * prefers-color-scheme, orientation, and/or/not combinators.
 * Returns true if condition matches (or is empty).
 */
function evalMediaQuery(condition: string): boolean {
  if (!condition) return true;
  var vp = getViewport();
  var c = condition.trim().toLowerCase();

  // "all" or "screen" — always matches
  if (c === 'all' || c === 'screen' || c === '') return true;
  if (c === 'print') return false;  // we're not a printer

  // Handle "not" prefix
  if (c.startsWith('not ')) return !evalMediaQuery(c.slice(4));

  // Handle "and" — all sub-conditions must match
  if (c.indexOf(' and ') !== -1) {
    var parts = c.split(' and ');
    for (var ai = 0; ai < parts.length; ai++) {
      if (!evalMediaQuery(parts[ai].trim())) return false;
    }
    return true;
  }

  // Handle comma (or) — any sub-condition must match
  if (c.indexOf(',') !== -1) {
    var orParts = c.split(',');
    for (var oi = 0; oi < orParts.length; oi++) {
      if (evalMediaQuery(orParts[oi].trim())) return true;
    }
    return false;
  }

  // Strip parens: (min-width: 768px)
  if (c.startsWith('(') && c.endsWith(')')) c = c.slice(1, -1).trim();

  // Feature queries
  var colonIdx = c.indexOf(':');
  if (colonIdx !== -1) {
    var feature = c.slice(0, colonIdx).trim();
    var value   = c.slice(colonIdx + 1).trim();
    var px = parseFloat(value);

    if (feature === 'min-width')  return vp.w >= px;
    if (feature === 'max-width')  return vp.w <= px;
    if (feature === 'min-height') return vp.h >= px;
    if (feature === 'max-height') return vp.h <= px;
    if (feature === 'orientation') return value === 'landscape' ? vp.w >= vp.h : vp.w < vp.h;
    if (feature === 'prefers-color-scheme') return value === 'light';  // JSOS browser has light background
    if (feature === 'prefers-reduced-motion') return value === 'no-preference';
    if (feature === '-webkit-min-device-pixel-ratio' || feature === 'min-resolution') return true;
  }

  // Bare media type
  if (c === 'screen' || c === 'all') return true;
  return true;  // unknown → include rules (fail-open)
}

// ── @supports query evaluator ─────────────────────────────────────────────────

/** Set of CSS properties the browser engine knows how to parse. */
var _supportedProps = new Set([
  'display', 'position', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow',
  'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-self',
  'align-content', 'order', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-column', 'grid-row', 'grid-area',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'padding', 'border', 'border-radius', 'box-sizing',
  'color', 'background', 'background-color', 'background-image',
  'font-size', 'font-weight', 'font-family', 'font-style',
  'text-align', 'text-decoration', 'text-transform', 'text-overflow',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space',
  'overflow', 'z-index', 'opacity', 'visibility', 'cursor',
  'transform', 'transition', 'animation',
  'box-shadow', 'text-shadow', 'outline',
  'float', 'clear', 'vertical-align',
]);

/**
 * Evaluate a CSS @supports condition.
 * Supports: (property: value), not, and, or combinators.
 * Returns true if condition is supported (or unknown → fail-open).
 */
function evalSupportsQuery(condition: string): boolean {
  if (!condition) return true;
  var c = condition.trim();

  // Handle "not" prefix
  if (c.toLowerCase().startsWith('not ')) return !evalSupportsQuery(c.slice(4));

  // Handle "and" — split only outside parens
  if (c.toLowerCase().indexOf(' and ') !== -1) {
    var parts = _splitOutsideParens(c, ' and ');
    if (parts.length > 1) {
      for (var i = 0; i < parts.length; i++) {
        if (!evalSupportsQuery(parts[i].trim())) return false;
      }
      return true;
    }
  }

  // Handle "or"
  if (c.toLowerCase().indexOf(' or ') !== -1) {
    var orParts = _splitOutsideParens(c, ' or ');
    if (orParts.length > 1) {
      for (var j = 0; j < orParts.length; j++) {
        if (evalSupportsQuery(orParts[j].trim())) return true;
      }
      return false;
    }
  }

  // Strip outer parens: (display: flex) → display: flex
  if (c.startsWith('(') && c.endsWith(')')) c = c.slice(1, -1).trim();

  // Property: value check
  var colonIdx = c.indexOf(':');
  if (colonIdx !== -1) {
    var prop = c.slice(0, colonIdx).trim().toLowerCase();
    return _supportedProps.has(prop);
  }

  return true;  // unknown → fail-open
}

/** Split string by delimiter but only outside parentheses. */
function _splitOutsideParens(s: string, delim: string): string[] {
  var parts: string[] = [];
  var depth = 0;
  var start = 0;
  var dl = delim.length;
  for (var i = 0; i <= s.length - dl; i++) {
    var cc = s.charCodeAt(i);
    if (cc === 40 /*()*/) depth++;
    else if (cc === 41 /*))*/) depth--;
    else if (depth === 0 && s.slice(i, i + dl).toLowerCase() === delim.toLowerCase()) {
      parts.push(s.slice(start, i));
      start = i + dl;
      i += dl - 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
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
// ── Stylesheet parse cache ─────────────────────────────────────────────────
// Caches parsed CSSRule[] by CSS text hash to avoid reparsing identical
// <style> blocks (Google re-injects the same styles on DOM mutations,
// and page reloads see the same content).
var _sheetCache = new Map<string, CSSRule[]>();
var _sheetCacheHits = 0;

export function flushSheetCache(): void { _sheetCache.clear(); _sheetCacheHits = 0; }

export function parseStylesheet(css: string): CSSRule[] {
  // Check cache — use first 200 chars + length as key (fast, low collision)
  var _cacheKey = css.length + ':' + css.slice(0, 200);
  var _cached = _sheetCache.get(_cacheKey);
  if (_cached) {
    _sheetCacheHits++;
    // Return cloned rules to avoid mutation of cached data
    // (order field is stamped per-use by buildRuleIndex)
    var cloned: CSSRule[] = new Array(_cached.length);
    for (var _ci2 = 0; _ci2 < _cached.length; _ci2++) {
      var _cr = _cached[_ci2]!;
      cloned[_ci2] = { sels: _cr.sels, parsedSels: _cr.parsedSels, props: _cr.props, spec: _cr.spec, order: 0 };
    }
    return cloned;
  }

  var rules: CSSRule[] = [];

  // Remove comments — indexOf scan (faster than regex in QuickJS's regex engine)
  if (css.indexOf('/*') >= 0) {
    var _parts: string[] = [];
    var _ci = 0;
    while (_ci < css.length) {
      var _cmtStart = css.indexOf('/*', _ci);
      if (_cmtStart < 0) { _parts.push(css.slice(_ci)); break; }
      if (_cmtStart > _ci) _parts.push(css.slice(_ci, _cmtStart));
      var _cmtEnd = css.indexOf('*/', _cmtStart + 2);
      if (_cmtEnd < 0) break; // unterminated comment — drop rest
      _ci = _cmtEnd + 2;
    }
    css = _parts.join('');
  }

  // Note: @charset, @import, @namespace are already handled by the main parser
  // loop (at-rule with `;` → skip), so no pre-processing needed.

  var i = 0;

  // charCodeAt constants — avoids single-char string allocation per css[i] access
  var CC_SPACE = 32, CC_AT = 64, CC_LBRACE = 123, CC_RBRACE = 125;
  var CC_SEMI = 59, CC_LPAREN = 40, CC_RPAREN = 41;
  var CC_DQUOTE = 34, CC_SQUOTE = 39, CC_BSLASH = 92;

  function skipWs(): void { while (i < css.length && css.charCodeAt(i) <= CC_SPACE) i++; }

  // Read until one of stop chars, or end.  Uses charCodeAt to avoid allocations.
  function readUntil(stop: string): string {
    var start = i;
    var depth = 0;
    // Pre-compute stop char codes for fast comparison
    var s0 = stop.charCodeAt(0), s1 = stop.length > 1 ? stop.charCodeAt(1) : -1;
    var s2 = stop.length > 2 ? stop.charCodeAt(2) : -1;
    while (i < css.length) {
      var cc = css.charCodeAt(i);
      if (cc === CC_LPAREN) { depth++; i++; continue; }
      if (cc === CC_RPAREN) { depth--; if (depth < 0) depth = 0; i++; continue; }
      if (cc === CC_DQUOTE || cc === CC_SQUOTE) {
        var q = cc; i++;
        while (i < css.length && css.charCodeAt(i) !== q) {
          if (css.charCodeAt(i) === CC_BSLASH) i++;
          i++;
        }
        i++; continue;
      }
      if (depth === 0 && (cc === s0 || cc === s1 || cc === s2)) break;
      i++;
    }
    return css.slice(start, i).trim();
  }

  while (i < css.length) {
    skipWs();
    if (i >= css.length) break;

    // At-rule
    if (css.charCodeAt(i) === CC_AT) {
      i++;
      var atKw = readUntil(' {;').replace(/\s+/g, '').toLowerCase();
      skipWs();
      if (i < css.length && css.charCodeAt(i) === CC_SEMI) { i++; continue; } // @import etc
      if (i < css.length && css.charCodeAt(i) === CC_LBRACE) {
        i++;
        // For @media — parse inner rules if query matches
        if (atKw.startsWith('media') || atKw.startsWith('supports') || atKw.startsWith('layer')) {
          // Read inner content (handles one level of nesting)
          var depth2 = 1;
          var start2 = i;
          while (i < css.length && depth2 > 0) {
            var _cc2 = css.charCodeAt(i);
            if (_cc2 === CC_LBRACE) depth2++;
            else if (_cc2 === CC_RBRACE) depth2--;
            i++;
          }
          var inner = css.slice(start2, i - 1);
          // Evaluate @media condition (skip on mismatch)
          var shouldInclude = true;
          if (atKw.startsWith('media')) {
            var mediaCondition = atKw.slice(5).trim();
            shouldInclude = evalMediaQuery(mediaCondition);
          } else if (atKw.startsWith('supports')) {
            var supportsCondition = atKw.slice(8).trim();
            shouldInclude = evalSupportsQuery(supportsCondition);
          }
          // @layer — always include (layer ordering not implemented)
          if (shouldInclude) {
            var innerRules = parseStylesheet(inner);
            for (var _iri = 0; _iri < innerRules.length; _iri++) rules.push(innerRules[_iri]!);
          }
        } else {
          // Skip other at-rule blocks (@keyframes, @font-face, etc.)
          var d3 = 1;
          while (i < css.length && d3 > 0) {
            var _cc3 = css.charCodeAt(i);
            if (_cc3 === CC_LBRACE) d3++;
            else if (_cc3 === CC_RBRACE) d3--;
            i++;
          }
        }
      }
      continue;
    }

    // Regular rule: selector(s) { declarations (may contain nested rules) }
    var selText = readUntil('{};');
    if (i >= css.length || css.charCodeAt(i) !== CC_LBRACE) { i++; continue; }
    i++; // consume {

    // Read balanced block content (handles nested {})
    var blockStart = i;
    var blockDepth = 1;
    while (i < css.length && blockDepth > 0) {
      var bcc = css.charCodeAt(i);
      if (bcc === CC_LBRACE) blockDepth++;
      else if (bcc === CC_RBRACE) blockDepth--;
      if (blockDepth > 0) i++;
    }
    var fullBlock = css.slice(blockStart, i);
    if (i < css.length && css.charCodeAt(i) === CC_RBRACE) i++; // consume }

    selText = selText.trim();
    if (!selText || !fullBlock.trim()) continue;

    // Check if block contains nested rules (CSS nesting: & .child { ... })
    if (fullBlock.indexOf('{') !== -1) {
      // Separate declarations from nested rules
      var decls = '';
      var ni = 0;
      while (ni < fullBlock.length) {
        // Skip whitespace
        while (ni < fullBlock.length && fullBlock.charCodeAt(ni) <= 32) ni++;
        if (ni >= fullBlock.length) break;
        // Check if this is a nested rule (contains { before ;)
        var nextBrace = fullBlock.indexOf('{', ni);
        var nextSemi  = fullBlock.indexOf(';', ni);
        if (nextBrace !== -1 && (nextSemi === -1 || nextBrace < nextSemi)) {
          // This is a nested rule — extract selector and balanced body
          var nestedSel = fullBlock.slice(ni, nextBrace).trim();
          ni = nextBrace + 1;
          var nd2 = 1;
          var nBodyStart = ni;
          while (ni < fullBlock.length && nd2 > 0) {
            var _ncc = fullBlock.charCodeAt(ni);
            if (_ncc === CC_LBRACE) nd2++;
            else if (_ncc === CC_RBRACE) nd2--;
            if (nd2 > 0) ni++;
          }
          var nestedBody = fullBlock.slice(nBodyStart, ni);
          if (ni < fullBlock.length) ni++; // skip }

          // Flatten: replace & with parent selector, or prepend parent + space
          var parentSels = splitSelectors(selText);
          for (var ps = 0; ps < parentSels.length; ps++) {
            var pSel = parentSels[ps]!;
            var flatSel: string;
            if (nestedSel.indexOf('&') !== -1) {
              flatSel = nestedSel.replace(/&/g, pSel);
            } else {
              flatSel = pSel + ' ' + nestedSel;
            }
            // Recursively parse nested rule (supports multi-level nesting)
            var nestedRules = parseStylesheet(flatSel + '{' + nestedBody + '}');
            for (var _nri = 0; _nri < nestedRules.length; _nri++) rules.push(nestedRules[_nri]!);
          }
        } else {
          // Regular declaration — collect until ;
          var dEnd = nextSemi !== -1 ? nextSemi + 1 : fullBlock.length;
          decls += fullBlock.slice(ni, dEnd);
          ni = dEnd;
        }
      }

      // Emit parent rule with its own declarations (if any)
      if (decls.trim()) {
        var props = parseDeclBlock(decls);
        var sels2 = splitSelectors(selText);
        var parsedSels2: ParsedSel[] = [];
        var spec2 = 0;
        for (var si2 = 0; si2 < sels2.length; si2++) {
          var _ps2 = _parseSel(sels2[si2]!);
          parsedSels2.push(_ps2);
          var s3 = _specFromParsed(_ps2);
          if (s3 > spec2) spec2 = s3;
        }
        rules.push({ sels: sels2, parsedSels: parsedSels2, props, spec: spec2, order: rules.length });
      }
    } else {
      // No nesting — simple rule
      var props = parseDeclBlock(fullBlock);
      var sels  = splitSelectors(selText);
      var parsedSels: ParsedSel[] = [];
      var spec = 0;
      for (var si = 0; si < sels.length; si++) {
        var _ps = _parseSel(sels[si]!);
        parsedSels.push(_ps);
        var s2 = _specFromParsed(_ps);
        if (s2 > spec) spec = s2;
      }
      rules.push({ sels, parsedSels, props, spec, order: rules.length });
    }
  }

  // parsedSels are now built inline during rule creation (no separate pass needed)
  // Cache for future use (bounded to 128 entries)
  if (_sheetCache.size < 128) {
    _sheetCache.set(_cacheKey, rules);
  }
  return rules;
}

/** Split a selector text on commas, but not inside parentheses. */
function splitSelectors(sel: string): string[] {
  var parts: string[] = [];
  var depth = 0;
  var start = 0;
  // charCodeAt avoids 1-char string allocation per sel[i] access
  var _LP = 40, _RP = 41, _COMMA = 44;
  for (var i = 0; i < sel.length; i++) {
    var cc = sel.charCodeAt(i);
    if (cc === _LP) depth++;
    else if (cc === _RP) depth--;
    else if (cc === _COMMA && depth === 0) {
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

// Maps CSS property name strings → CSSProps field name(s) they affect.
// Used to resolve 'inherit'/'initial' cascaded keyword markers.
var _CSS_PROP_MAP: Record<string, Array<keyof CSSProps>> = {
  'color':                    ['color'],
  'background-color':         ['bgColor'],
  'background-image':         ['backgroundImage'],
  'background-repeat':        ['backgroundRepeat'],
  'background-size':          ['backgroundSize'],
  'background-position':      ['backgroundPosition'],
  'font-size':                ['fontScale'],
  'font-weight':              ['bold', 'fontWeight'],
  'font-style':               ['italic'],
  'font-family':              ['fontFamily'],
  'font-variant':             ['fontVariant'],
  'font-kerning':             ['fontKerning'],
  'line-height':              ['lineHeight'],
  'letter-spacing':           ['letterSpacing'],
  'word-spacing':             ['wordSpacing'],
  'text-align':               ['align'],
  'text-transform':           ['textTransform'],
  'text-decoration':          ['underline', 'strike', 'textDecoration'],
  'text-overflow':            ['textOverflow'],
  'text-indent':              ['textIndent'],
  'text-shadow':              ['textShadow'],
  'white-space':              ['whiteSpace'],
  'word-break':               ['wordBreak'],
  'overflow-wrap':            ['overflowWrap'],
  'vertical-align':           ['verticalAlign'],
  'list-style-type':          ['listStyleType'],
  'cursor':                   ['cursor'],
  'visibility':               ['visibility'],
  'border-collapse':          ['borderCollapse'],
  'border-spacing':           ['borderSpacing'],
  'hyphens':                  ['hyphens'],
  'quotes':                   ['quotes'],
  'color-scheme':             ['colorScheme'],
  'display':                  ['display'],
  'box-sizing':               ['boxSizing'],
  'width':                    ['width'],
  'height':                   ['height'],
  'min-width':                ['minWidth'],
  'min-height':               ['minHeight'],
  'max-width':                ['maxWidth'],
  'max-height':               ['maxHeight'],
  'padding-top':              ['paddingTop'],
  'padding-right':            ['paddingRight'],
  'padding-bottom':           ['paddingBottom'],
  'padding-left':             ['paddingLeft'],
  'margin-top':               ['marginTop'],
  'margin-right':             ['marginRight'],
  'margin-bottom':            ['marginBottom'],
  'margin-left':              ['marginLeft'],
  'border-width':             ['borderWidth'],
  'border-style':             ['borderStyle'],
  'border-color':             ['borderColor'],
  'border-radius':            ['borderRadius'],
  'border-top-left-radius':   ['borderTopLeftRadius'],
  'border-top-right-radius':  ['borderTopRightRadius'],
  'border-bottom-right-radius': ['borderBottomRightRadius'],
  'border-bottom-left-radius': ['borderBottomLeftRadius'],

  'outline-width':            ['outlineWidth'],
  'outline-color':            ['outlineColor'],
  'opacity':                  ['opacity'],
  'box-shadow':               ['boxShadow'],
  'filter':                   ['filter'],
  'clip-path':                ['clipPath'],
  'position':                 ['position'],
  'top':                      ['top'],
  'right':                    ['right'],
  'bottom':                   ['bottom'],
  'left':                     ['left'],
  'z-index':                  ['zIndex'],
  'overflow':                 ['overflow', 'overflowX', 'overflowY'],
  'overflow-x':               ['overflowX'],
  'overflow-y':               ['overflowY'],
  'flex-direction':           ['flexDirection'],
  'flex-wrap':                ['flexWrap'],
  'flex-grow':                ['flexGrow'],
  'flex-shrink':              ['flexShrink'],
  'flex-basis':               ['flexBasis'],
  'align-items':              ['alignItems'],
  'align-self':               ['alignSelf'],
  'justify-content':          ['justifyContent'],
  'gap':                      ['gap'],
  'row-gap':                  ['rowGap'],
  'column-gap':               ['columnGap'],
  'grid-template-columns':    ['gridTemplateColumns'],
  'grid-template-rows':       ['gridTemplateRows'],
  'grid-area':                ['gridArea'],
  'grid-column':              ['gridColumn'],
  'grid-row':                 ['gridRow'],
  'transform':                ['transform'],
  'transform-origin':         ['transformOrigin'],
  'object-fit':               ['objectFit'],
  'object-position':          ['objectPosition'],
  'aspect-ratio':             ['aspectRatio'],
  'pointer-events':           ['pointerEvents'],
  'touch-action':             ['touchAction'],
  'fill':                     ['fill'],
  'stroke':                   ['stroke'],
  'stroke-width':             ['strokeWidth'],
  'float':                    ['float'],
  'clear':                    ['clear'],
  'content':                  ['content'],
  'user-select':              ['userSelect'],
  'indent':                   ['indent'],
};

/**
 * After mergeProps, apply any 'inherit'/'initial'/'unset'/'revert' keyword
 * markers recorded in _inherit/_initial Sets during CSS parsing.
 * - _inherit: set result[field] = inherited[field] (or delete if parent undefined)
 * - _initial: delete result[field] (renderer falls back to browser default)
 */
function _applyKeywords(result: CSSProps, props: CSSProps, inherited: CSSProps): void {
  if (props._inherit) props._inherit.forEach(cssProp => {
    var fields = _CSS_PROP_MAP[cssProp];
    if (!fields) return;
    fields.forEach(f => {
      var v = (inherited as Record<string, unknown>)[f as string];
      if (v !== undefined) (result as Record<string, unknown>)[f as string] = v;
      else delete (result as Record<string, unknown>)[f as string];
    });
  });
  if (props._initial) props._initial.forEach(cssProp => {
    var fields = _CSS_PROP_MAP[cssProp];
    if (!fields) return;
    fields.forEach(f => delete (result as Record<string, unknown>)[f as string]);
  });
}

/**
 * Resolve a CSS `content` property value to a plain string for rendering.
 * Handles: "string" literals, 'single-quoted' literals, none/normal (→''), attr(x),
 * and counter(name) / counter(name, style) using an optional counter value map.
 * Returns empty string for url() or unrecognised values.
 */
function _resolveContentValue(
  raw: string,
  attrs?: Map<string, string>,
  counters?: Map<string, number>,
): string {
  raw = raw.trim();
  if (!raw || raw === 'none' || raw === 'normal') return '';
  // Concatenated strings/tokens (e.g. "«" " " attr(title))
  var out = '';
  var i = 0;
  while (i < raw.length) {
    while (i < raw.length && raw[i] === ' ') i++;  // skip gaps
    if (i >= raw.length) break;
    var ch = raw[i];
    if (ch === '"' || ch === "'") {
      // quoted string literal
      var q = ch; i++;
      while (i < raw.length && raw[i] !== q) {
        if (raw[i] === '\\' && i + 1 < raw.length) { i++; out += raw[i]; }
        else out += raw[i];
        i++;
      }
      if (i < raw.length) i++;  // skip closing quote
    } else if (raw.slice(i, i + 5).toLowerCase() === 'attr(') {
      // attr(name) — look up element attribute
      i += 5;
      var attrEnd = raw.indexOf(')', i);
      if (attrEnd < 0) { i = raw.length; break; }
      var attrName = raw.slice(i, attrEnd).trim().toLowerCase();
      out += attrs ? (attrs.get(attrName) ?? '') : '';
      i = attrEnd + 1;
    } else if (raw.slice(i, i + 4).toLowerCase() === 'url(') {
      // url(...) — skip (images not supported in pseudo content)
      var urlEnd = raw.indexOf(')', i + 4);
      i = urlEnd >= 0 ? urlEnd + 1 : raw.length;
    } else if (raw.slice(i, i + 8).toLowerCase() === 'counter(') {
      // counter(name) / counter(name, style) — look up counter value (item 434)
      var cntEnd = raw.indexOf(')', i + 8);
      if (cntEnd < 0) { i = raw.length; break; }
      var cntArgs = raw.slice(i + 8, cntEnd).trim();
      var cntName = cntArgs.split(',')[0]!.trim();
      var cntVal = counters ? (counters.get(cntName) ?? 0) : 0;
      out += String(cntVal);
      i = cntEnd + 1;
    } else {
      // bare word — check for "open-quote"/"close-quote"
      var tok = '';
      while (i < raw.length && raw[i] !== ' ' && raw[i] !== '"' && raw[i] !== "'") tok += raw[i++];
      if (tok === 'open-quote')  out += '\u201C';
      else if (tok === 'close-quote') out += '\u201D';
      // else: other bare words (no-open-quote etc.) → ignore
    }
  }
  return out;
}

/**
 * Find ::before / ::after content for an element based on the given stylesheets.
 * Used by the HTML parser to inject generated content spans.
 * Returns '' for each pseudo-element that has no matching rule.
 */
export function getPseudoContent(
  tag:   string,
  id:    string,
  cls:   string[],
  attrs: Map<string, string>,
  sheets: CSSRule[],
  index?: RuleIndex | null,
  counters?: Map<string, number>,
  ancestors?: AncestorEl[],
  sibIdx?: number,
  sibCount?: number,
): { before: string; after: string } {
  // Fast path: if we have an index and no rules have content, skip entirely
  if (index && index.contentRules.length === 0) return _EMPTY_PSEUDO;

  var before = '';
  var after  = '';
  var beforeSpec = -1;
  var afterSpec  = -1;
  // Use only content-bearing rules when index is available (much smaller set)
  var candidates = index ? index.contentRules : sheets;
  for (var ri = 0; ri < candidates.length; ri++) {
    var rule = candidates[ri]!;
    if (!rule.props.content) continue;   // skip rules without content
    // Lazily build pseudo-element info cache on first access (avoids regex per element)
    if (!rule._pseudoInfos) {
      rule._pseudoInfos = [];
      for (var _pi = 0; _pi < rule.sels.length; _pi++) {
        var _psel = rule.sels[_pi]!.trim();
        var _ppem = _psel.match(/::?(before|after)\s*$/i);
        if (_ppem) {
          var _hostRaw = _psel.slice(0, _psel.length - _ppem[0].length).trim() || '*';
          rule._pseudoInfos.push({
            pseudo: _ppem[1]!.toLowerCase() as 'before' | 'after',
            hostParsed: _parseSel(_hostRaw),
          });
        } else {
          rule._pseudoInfos.push(null);
        }
      }
    }
    for (var si = 0; si < rule._pseudoInfos.length; si++) {
      var pInfo = rule._pseudoInfos[si];
      if (!pInfo) continue;
      // Use pre-parsed host selector — no regex, no string alloc on hot path
      if (!matchesParsedSel(tag, id, cls, attrs, pInfo.hostParsed, ancestors, sibIdx, sibCount)) continue;
      var resolved = _resolveContentValue(rule.props.content, attrs, counters);
      if (pInfo.pseudo === 'before' && rule.spec > beforeSpec) {
        before = resolved; beforeSpec = rule.spec;
      } else if (pInfo.pseudo === 'after' && rule.spec > afterSpec) {
        after = resolved;  afterSpec  = rule.spec;
      }
      break;  // only one selector per rule matches per pseudo
    }
  }
  return before || after ? { before, after } : _EMPTY_PSEUDO;
}

/**
 * Compute the cascaded CSSProps for an element, given:
 *  - tag, id, cls  — element descriptor
 *  - attrs         — element attribute map (for [attr=val] selectors)
 *  - inherited     — inherited CSSProps from parent (color, font-weight etc.)
 *  - sheets        — sorted stylesheet rules (in source order)
 *  - inlineStyle   — inline style="" attribute string (highest priority)
 *  - index         — optional pre-built rule index for O(1) pre-filtering
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
  index?:      RuleIndex,
  ancestors?:  AncestorEl[],
  sibIdx?:     number,
  sibCount?:   number,
  sortedClsKey?: string,
): CSSProps {
  // ── Inherited starting values (CSS-spec inheritable properties) ────────────
  var result: CSSProps = {
    color:         inherited.color,
    bold:          inherited.bold,
    italic:        inherited.italic,
    align:         inherited.align,
    fontScale:     inherited.fontScale,
    fontFamily:    inherited.fontFamily,
    fontWeight:    inherited.fontWeight,
    lineHeight:    inherited.lineHeight,
    letterSpacing: inherited.letterSpacing,
    wordSpacing:   inherited.wordSpacing,
    textTransform: inherited.textTransform,
    whiteSpace:    inherited.whiteSpace,
    listStyleType: inherited.listStyleType,
    cursor:        inherited.cursor,
    wordBreak:     inherited.wordBreak,
    overflowWrap:  inherited.overflowWrap,
    visibility:    inherited.visibility,
    borderCollapse: inherited.borderCollapse,
    borderSpacing:  inherited.borderSpacing,
    hyphens:        inherited.hyphens,
    quotes:         inherited.quotes,
    fontVariant:    inherited.fontVariant,
    fontKerning:    inherited.fontKerning,
    colorScheme:    inherited.colorScheme,
  };

  // ── Collect matching rules (with result cache for stable elements) ─────────
  // Cache key: tag + filteredId + CSS-relevant-cls only — inlineStyle is
  // intentionally excluded so that elements with unique inline styles
  // (e.g. style="left: Npx") still get cache hits for their sheet-matched rules.
  // Cache is flushed (via flushCSSMatchCache) whenever sheets change.
  //
  // Key optimizations for cache hit rate:
  //  1. Strip classes not referenced in any CSS selector.
  //  2. Strip IDs not referenced in any CSS selector.
  // CSS-in-JS pages (Google, React) add many IDs/classes for JavaScript purposes
  // (event handlers, DOM queries) that don't match any CSS rule.  Including
  // them in the cache key creates unique keys for elements that would otherwise
  // share the same matched rules.
  var _filteredCls: string;
  var _filteredId = id;
  if (index) {
    // Strip ID from cache key if not referenced by any CSS selector
    if (id && !index.idBuckets.has(id)) _filteredId = '';
    var _ccSet = index.cssClassSet;
    if (cls.length === 0) {
      _filteredCls = '';
    } else if (cls.length === 1) {
      _filteredCls = _ccSet.has(cls[0]!) ? cls[0]! : '';
    } else {
      var _fc: string[] = [];
      for (var _fi = 0; _fi < cls.length; _fi++) {
        if (_ccSet.has(cls[_fi]!)) _fc.push(cls[_fi]!);
      }
      _filteredCls = _fc.length > 1 ? _fc.sort().join(' ') : (_fc[0] || '');
    }
  } else {
    _filteredCls = sortedClsKey !== undefined ? sortedClsKey
      : cls.length > 1 ? cls.slice().sort().join(' ') : (cls[0] || '');
  }
  var _cacheKey = tag + '\x00' + _filteredId + '\x00' + _filteredCls;
  _cssMatchTotal++;
  var _cachedMatch = _cssMatchCache.get(_cacheKey);

  if (_cachedMatch) {
    // ── Cache hit ──────────────────────────────────────────────────────────
    _cssMatchHits++;
    if (!_cachedMatch.hasKeywords) {
      // Fast path (common): no inherit/initial keywords — one mergeProps call
      mergeProps(result, _cachedMatch.normalMerged);
    } else {
      // Slow path (rare): iterate individual matches for correct keyword ordering
      var _mp = _cachedMatch.matchProps!;
      for (var mi = 0; mi < _mp.length; mi++) {
        mergeProps(result, _mp[mi]!);
        if (_mp[mi]!._inherit || _mp[mi]!._initial) _applyKeywords(result, _mp[mi]!, inherited);
      }
    }
    // Inline style
    if (inlineStyle) {
      var inlineParsed = _declBlockCache.get(inlineStyle);
      if (!inlineParsed) {
        inlineParsed = parseInlineStyle(inlineStyle);
        if (_declBlockCache.size < 4096) _declBlockCache.set(inlineStyle, inlineParsed);
      }
      mergeProps(result, inlineParsed);
      if (inlineParsed._inherit || inlineParsed._initial) _applyKeywords(result, inlineParsed, inherited);
    }
    // Important rules override inline normal
    if (_cachedMatch.importantProps) {
      for (var ii = 0; ii < _cachedMatch.importantProps.length; ii++) {
        var imp = _cachedMatch.importantProps[ii]!;
        mergeProps(result, imp, imp.important);
        if (imp._inherit || imp._initial) _applyKeywords(result, imp, inherited);
      }
    }
    return result;
  }

  // ── Cache miss — match rules, pre-merge, and cache ────────────────────────
  var candidates: CSSRule[] = index
    ? candidateRules(index, tag, id, cls)
    : sheets;
  // Build O(1) class lookup Set only for elements with many classes (>4).
  // For small class lists, Array.includes() is faster than Set construction +
  // Set.has() in QuickJS.  _matchParsedCompound already falls back to includes().
  var _clsSet: Set<string> | null = cls.length > 4 ? new Set<string>(cls) : null;

  // Collect matches into module-level parallel arrays (avoids 3 array
  // allocations per cache miss — safe since computeElementStyle is non-recursive).
  _gmLen = 0;

  for (var ri = 0; ri < candidates.length; ri++) {
    var rule = candidates[ri]!;
    // Skip rules that only match via :hover/:focus/:active (never match during static layout)
    if (rule._stateOnly) continue;
    // Fast pre-rejection: check rightmost compound tag/class/id before calling
    // the full matchesParsedSel function.  Saves function-call overhead entirely
    // for rules that can't match this element.
    var _rt = rule._reqTag;
    if (_rt !== undefined && _rt !== tag) continue;
    var _rcs = rule._reqClasses;
    if (_rcs !== undefined) {
      var _clsMiss = false;
      if (_clsSet) {
        for (var _ci = 0; _ci < _rcs.length; _ci++) { if (!_clsSet.has(_rcs[_ci]!)) { _clsMiss = true; break; } }
      } else {
        for (var _ci = 0; _ci < _rcs.length; _ci++) { if (cls.indexOf(_rcs[_ci]!) < 0) { _clsMiss = true; break; } }
      }
      if (_clsMiss) continue;
    }
    var _rid = rule._reqId;
    if (_rid !== undefined && _rid !== id) continue;
    // Fast path: simple single-compound rules with no pseudos/attrs —
    // all pre-checks passed above, so the rule matches without calling matchesParsedSel.
    // This eliminates 2 function calls (matchesParsedSel + _matchParsedCompound) per rule.
    if (rule._simpleMatch) {
      var srcOrder = index ? rule.order : ri;
      _gmProps[_gmLen] = rule.props; _gmSpec[_gmLen] = rule.spec; _gmOrder[_gmLen] = srcOrder; _gmLen++;
      continue;
    }
    // Hot path: use pre-parsed selectors (no regex) when available
    if (rule.parsedSels) {
      for (var si = 0; si < rule.parsedSels.length; si++) {
        if (matchesParsedSel(tag, id, cls, attrs, rule.parsedSels[si]!, ancestors, sibIdx, sibCount, _clsSet)) {
          var srcOrder = index ? rule.order : ri;
          _gmProps[_gmLen] = rule.props; _gmSpec[_gmLen] = rule.spec; _gmOrder[_gmLen] = srcOrder; _gmLen++;
          break;
        }
      }
    } else {
      for (var si = 0; si < rule.sels.length; si++) {
        if (matchesSingleSel(tag, id, cls, attrs, rule.sels[si]!, ancestors, sibIdx, sibCount)) {
          var srcOrder = index ? rule.order : ri;
          _gmProps[_gmLen] = rule.props; _gmSpec[_gmLen] = rule.spec; _gmOrder[_gmLen] = srcOrder; _gmLen++;
          break;
        }
      }
    }
  }

  // Sort by specificity then source order (insertion sort for small N)
  if (_gmLen > 1) {
    // Simple insertion sort — typically < 20 matches
    for (var i = 1; i < _gmLen; i++) {
      var tmpP = _gmProps[i]!, tmpS = _gmSpec[i]!, tmpO = _gmOrder[i]!;
      var j = i - 1;
      while (j >= 0 && (_gmSpec[j]! > tmpS || (_gmSpec[j]! === tmpS && _gmOrder[j]! > tmpO))) {
        _gmProps[j + 1] = _gmProps[j]!; _gmSpec[j + 1] = _gmSpec[j]!; _gmOrder[j + 1] = _gmOrder[j]!;
        j--;
      }
      _gmProps[j + 1] = tmpP; _gmSpec[j + 1] = tmpS; _gmOrder[j + 1] = tmpO;
    }
  }

  // Pre-merge for cache + apply to result
  var normalMerged: CSSProps = {} as CSSProps;
  var importantProps: CSSProps[] | null = null;
  var hasKeywords = false;

  for (var mi = 0; mi < _gmLen; mi++) {
    var mp = _gmProps[mi]!;
    if (mp.important && mp.important.size > 0) {
      if (!importantProps) importantProps = [];
      importantProps.push(mp);
    }
    mergeProps(normalMerged, mp);
    mergeProps(result, mp);
    if (mp._inherit || mp._initial) {
      hasKeywords = true;
      _applyKeywords(result, mp, inherited);
    }
  }

  // Store in cache (bounded to 8192 entries)
  if (_cssMatchCache.size < 8192) {
    // Pre-compute _ks on normalMerged so cache-hit mergeProps uses fast array path
    var _nmKeys = Object.keys(normalMerged);
    var _nmKs: string[] = [];
    for (var _nki = 0; _nki < _nmKeys.length; _nki++) {
      var _nk = _nmKeys[_nki]!;
      if (_nk !== 'important' && _nk !== '_inherit' && _nk !== '_initial' && _nk !== '_ks') _nmKs.push(_nk);
    }
    (normalMerged as any)._ks = _nmKs;
    var cacheEntry: CSSMatchEntry = {
      normalMerged: normalMerged,
      importantProps: importantProps,
      hasKeywords: hasKeywords,
    };
    // Only store individual match props when keywords require per-rule iteration
    // Must copy from global buffer since _gmProps is reused across calls
    if (hasKeywords) {
      var _mpCopy: CSSProps[] = [];
      for (var _ci = 0; _ci < _gmLen; _ci++) _mpCopy.push(_gmProps[_ci]!);
      cacheEntry.matchProps = _mpCopy;
    }
    _cssMatchCache.set(_cacheKey, cacheEntry);
  }

  // ── Inline style wins over normal sheet rules ──────────────────────────────
  if (inlineStyle) {
    var inlineParsed = _declBlockCache.get(inlineStyle);
    if (!inlineParsed) {
      inlineParsed = parseInlineStyle(inlineStyle);
      if (_declBlockCache.size < 4096) _declBlockCache.set(inlineStyle, inlineParsed);
    }
    mergeProps(result, inlineParsed);
    if (inlineParsed._inherit || inlineParsed._initial) _applyKeywords(result, inlineParsed, inherited);
  }

  // ── !important sheet rules override inline normal style ───────────────────
  // importantProps is already in cascade order (from sorted matches)
  if (importantProps) {
    for (var ii = 0; ii < importantProps.length; ii++) {
      var imp = importantProps[ii]!;
      mergeProps(result, imp, imp.important);
      if (imp._inherit || imp._initial) _applyKeywords(result, imp, inherited);
    }
  }

  // ── Inline !important beats sheet !important (CSS cascade level, R16) ─────
  // Per CSS spec, inline !important has highest precedence after transitions.
  if (inlineStyle && importantProps) {
    var _inlImp = _declBlockCache.get(inlineStyle);
    if (_inlImp && _inlImp.important && _inlImp.important.size > 0) {
      mergeProps(result, _inlImp, _inlImp.important);
    }
  }

  return result;
}

// ── Index helpers ─────────────────────────────────────────────────────────────

/**
 * Build a rule index for the given sheet rules.
 * The index allows O(1) pre-filtering of candidate rules per element,
 * reducing CSS matching from O(rules) to O(candidates).
 */
export function buildSheetIndex(rules: CSSRule[]): RuleIndex {
  // Pre-classify rules: mark those that ONLY match via :hover/:focus/:active
  // so the matching loop can skip them during static layout (save ~20% work).
  // Also pre-compute _reqTag, _reqClasses, _reqId, _simpleMatch for the rightmost compound of each
  // rule's FIRST parsed selector — enables fast pre-rejection in matching loop
  // without calling matchesParsedSel() at all (saves function call overhead).
  var _statePseudos = new Set(['hover', 'focus', 'active', 'focus-within', 'focus-visible']);
  var _stateSkipped = 0;
  for (var _ssi = 0; _ssi < rules.length; _ssi++) {
    var _sr = rules[_ssi]!;
    if (_sr.parsedSels && _sr.parsedSels.length > 0) {
      var _allState = true;
      for (var _sj = 0; _sj < _sr.parsedSels.length && _allState; _sj++) {
        var _sComp = _sr.parsedSels[_sj]!.compounds;
        // Check if ANY compound in the selector chain has a state pseudo
        var _hasState = false;
        for (var _sk = 0; _sk < _sComp.length && !_hasState; _sk++) {
          var _sPseudos = _sComp[_sk]!.pseudos;
          for (var _sl = 0; _sl < _sPseudos.length; _sl++) {
            if (_statePseudos.has(_sPseudos[_sl]!.name)) { _hasState = true; break; }
          }
        }
        if (!_hasState) _allState = false;
      }
      _sr._stateOnly = _allState;
      if (_allState) _stateSkipped++;

      // Pre-compute rightmost compound data for fast pre-rejection.
      // Use the FIRST parsedSel (most common case: rules have only 1 selector
      // after comma-split).  Even for multi-selector rules, this is a valid
      // fast-fail: if ALL selectors share the same reqTag, the check is exact;
      // if they differ, we skip the pre-check (set undefined).
      var _rc0 = _sr.parsedSels[0]!.compounds[0];
      if (_rc0) {
        if (_sr.parsedSels.length === 1) {
          // Single selector: exact pre-rejection
          _sr._reqTag = _rc0.tag && _rc0.tag !== '*' ? _rc0.tag : undefined;
          // ALL classes from rightmost compound — fixes the bucket-key problem
          // where checking only the first class matches the bucket key and
          // never rejects.  Checking ALL classes catches multi-class mismatches.
          _sr._reqClasses = _rc0.classes.length > 0 ? _rc0.classes : undefined;
          _sr._reqId = _rc0.ids.length > 0 ? _rc0.ids[0] : undefined;
          // Fast path: single-compound, no pseudos, no attrs → skip matchesParsedSel
          var _ps0 = _sr.parsedSels[0]!;
          _sr._simpleMatch = _ps0.compounds.length === 1 &&
            _rc0.pseudos.length === 0 && _rc0.attrs.length === 0;
        } else {
          // Multi-selector: only set _reqTag if ALL selectors require the same tag
          var _commonTag: string | undefined = _rc0.tag && _rc0.tag !== '*' ? _rc0.tag : undefined;
          for (var _msi = 1; _msi < _sr.parsedSels.length && _commonTag; _msi++) {
            var _mrc = _sr.parsedSels[_msi]!.compounds[0];
            if (!_mrc || _mrc.tag !== _commonTag) _commonTag = undefined;
          }
          _sr._reqTag = _commonTag;
          // Don't set _reqClasses/_reqId/_simpleMatch for multi-selector rules
        }
      }
    }
  }
  var idx = buildRuleIndex(rules);
  // Debug: log how many rules landed in universalRules (checked for EVERY element)
  if (typeof os !== 'undefined' && os && os.debug) {
    var _simpleCount = 0;
    for (var _dbi = 0; _dbi < rules.length; _dbi++) { if (rules[_dbi]!._simpleMatch) _simpleCount++; }
    os.debug.log('[browser] ruleIndex: rules=' + rules.length +
      ' universalRules=' + idx.universalRules.length +
      ' stateOnly=' + _stateSkipped +
      ' simpleMatch=' + _simpleCount +
      ' classBuckets=' + idx.classBuckets.size +
      ' tagBuckets='   + idx.tagBuckets.size +
      ' idBuckets='    + idx.idBuckets.size +
      ' cssClassSet='  + idx.cssClassSet.size);
  }
  return idx;
}

export function mergeProps(target: CSSProps, src: CSSProps, importantOnly?: Set<string>): void {
  // Fast path: use pre-computed _ks array (set by parseInlineStyle/parseDeclBlock)
  // for O(N) counted-loop iteration instead of expensive for...in enumeration.
  var t = target as Record<string, unknown>;
  var s = src as Record<string, unknown>;
  var ks = (src as any)._ks as string[] | undefined;
  if (ks) {
    if (importantOnly) {
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i]!;
        if (!importantOnly.has(k)) continue;
        var _iv = s[k];
        if (_iv !== undefined) t[k] = _iv;
      }
    } else {
      for (var i = 0; i < ks.length; i++) {
        var _fv = s[ks[i]!];
        if (_fv !== undefined) t[ks[i]!] = _fv;
      }
    }
  } else {
    // Fallback for objects without _ks (e.g. normalMerged built inline)
    for (var k in s) {
      if (k === 'important' || k === '_inherit' || k === '_initial' || k === '_ks') continue;
      var v = s[k];
      if (v === undefined) continue;
      if (importantOnly && !importantOnly.has(k)) continue;
      t[k] = v;
    }
  }
}