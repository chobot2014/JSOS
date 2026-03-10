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
const _cssMatchCache = new Map<string, { props: CSSProps; spec: number; order: number }[]>();
var _cssMatchHits = 0;
var _cssMatchTotal = 0;

// ── Shared Set for O(1) class membership tests ───────────────────────────────
// A single reusable Set<string> is cleared and refilled per element in the
// cache-miss path.  This gives O(1) .has() lookups (same as per-element new
// Set) with ZERO extra allocations — no GC pressure from 100s of discarded
// Set objects per rerender.
// (Module-level declaration kept but actual Set created fresh per element for JIT stability)
var _clsMatchSet: Set<string> | null = null;


export { resetCSSVars, setViewport };

/** Clear the CSS match result cache (call on navigation / stylesheet change). */
export function flushCSSMatchCache(): void {
  _cssMatchCache.clear();
  _cssMatchHits  = 0;
  _cssMatchTotal = 0;
  _parsedCompoundCache.clear();
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
  // Parse all compound selector parts and compute specificity across ALL of them
  var parsed = _parseSelectorParts(sel);
  var a = 0, b = 0, c = 0;
  for (var pi = 0; pi < parsed.parts.length; pi++) {
    var part = parsed.parts[pi]!;
    // Count ID selectors
    var ids = part.match(/#[^.#[\s:]+/g);
    if (ids) a += ids.length;
    // Count class, attribute, pseudo-class selectors
    var clss = part.match(/\.[^.#[\s:]+|\[[^\]]+\]|:(?!:)[^.#[\s:(]+/g);
    if (clss) b += clss.length;
    // Count type selectors (non-* identifiers at start)
    if (part && part !== '*' && /^[a-zA-Z]/.test(part)) c++;
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
  var cur = '';
  var i = 0;
  while (i < sel.length) {
    var ch = sel[i]!;
    if (ch === '(') { depth++; cur += ch; i++; continue; }
    if (ch === ')') { depth--; cur += ch; i++; continue; }
    if (depth > 0)  { cur += ch; i++; continue; }
    if (ch === '>' || ch === '+' || ch === '~') {
      if (cur.trim()) { parts.push(cur.trim()); combinators.push(ch); }
      cur = ''; i++;
      while (i < sel.length && sel[i] === ' ') i++;
      continue;
    }
    if (ch === ' ') {
      // peek past spaces — if next non-space is >, + or ~ that combinator wins
      var j = i + 1;
      while (j < sel.length && sel[j] === ' ') j++;
      if (j < sel.length && (sel[j] === '>' || sel[j] === '+' || sel[j] === '~')) {
        // flush part, let the next char handle the explicit combinator
        if (cur.trim()) parts.push(cur.trim());
        cur = ''; i = j; continue;
      }
      // Otherwise this is a descendant combinator ' '
      if (cur.trim()) { parts.push(cur.trim()); combinators.push(' '); }
      cur = ''; i = j; continue;
    }
    cur += ch; i++;
  }
  if (cur.trim()) parts.push(cur.trim());
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

  var rest = compound;

  // Type selector at start
  var typeM = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (typeM) {
    tag = typeM[1]!.toLowerCase();
    rest = rest.slice(typeM[1]!.length);
  }

  // Parse remaining simple selectors iteratively
  while (rest.length > 0) {
    var ch = rest[0]!;
    if (ch === '#') {
      var idM = rest.match(/^#([^.#[:\s]+)/);
      if (!idM) break;
      ids.push(idM[1]!);
      rest = rest.slice(idM[0].length);
    } else if (ch === '.') {
      var clM = rest.match(/^\.([^.#[:\s]+)/);
      if (!clM) break;
      classes.push(clM[1]!);
      rest = rest.slice(clM[0].length);
    } else if (ch === '[') {
      var atM = rest.match(/^\[([^\]]+)\]/);
      if (!atM) break;
      var atExpr = atM[1]!;
      var eqM = atExpr.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)([~|^$*]?=)?(.+)?$/);
      if (eqM) {
        attrs.push({
          name: eqM[1]!.toLowerCase().trim(),
          op:   eqM[2] || '',
          val:  (eqM[3] || '').replace(/^['"]|['"]$/g, ''),
        });
      }
      rest = rest.slice(atM[0].length);
    } else if (ch === ':') {
      var psM = rest.match(/^::?([a-zA-Z-]+)(?:\(([^)]*)\))?/);
      if (!psM) { rest = rest.slice(1); continue; }
      var psName = psM[1]!.toLowerCase();
      var psArg  = psM[2] || '';
      rest = rest.slice(psM[0].length);
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
  }
  for (var i = 0; i < pc.pseudos.length; i++) {
    var ps = pc.pseudos[i]!;
    var pn = ps.name;
    if (pn === 'before' || pn === 'after' || pn === 'first-line' || pn === 'first-letter') {
      // pseudo-elements — match the host element
    } else if (pn === 'hover' || pn === 'focus' || pn === 'active' ||
               pn === 'focus-within' || pn === 'focus-visible') {
      // state pseudo-classes — optimistically match
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
    if (comb === '>') {
      if (ancIdx >= ancestors.length) return false;
      var pa = ancestors[ancIdx]!;
      if (!_matchParsedCompound(pa.tag, pa.id, pa.cls, null, pa.attrs, compounds[pi]!)) return false;
      ancIdx++;
    } else if (comb === ' ') {
      var found = false;
      while (ancIdx < ancestors.length) {
        var an = ancestors[ancIdx]!;
        ancIdx++;
        if (_matchParsedCompound(an.tag, an.id, an.cls, null, an.attrs, compounds[pi]!)) { found = true; break; }
      }
      if (!found) return false;
    }
    // + and ~ sibling combinators: optimistic pass
  }
  return true;
}

/**
 * Match a compound selector string (no combinators) against element descriptors.
 * E.g.: 'div.foo#bar[href]'
 */
function matchesCompound(
  tag: string, id: string, cls: string[],
  attrs: Map<string, string>,
  compound: string,
  sibIdx?: number,
  sibCount?: number,
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
      // Pseudo-class / pseudo-element handling
      // We evaluate structural pseudo-classes (first-child, last-child, nth-child,
      // not) and state pseudo-classes (:hover, :focus, :active, :checked, :disabled)
      // as best-effort based on available context.
      var psM = rest.match(/^::?([a-zA-Z-]+)(?:\(([^)]*)\))?/);
      if (psM) {
        var psName = psM[1]!.toLowerCase();
        var psArg  = psM[2] || '';
        rest = rest.slice(psM[0].length);
        // Pseudo-elements (::before, ::after) — match the host element
        if (psName === 'before' || psName === 'after' ||
            psName === 'first-line' || psName === 'first-letter') {
          // always match (host element rule applies)
        }
        // State pseudo-classes — always match (can't track hover/focus here)
        else if (psName === 'hover' || psName === 'focus' || psName === 'active' ||
                 psName === 'focus-within' || psName === 'focus-visible') {
          // match (optimistic: apply styles as if in state)
        }
        // Form pseudo-classes
        else if (psName === 'checked' || psName === 'selected') {
          var chk = attrs.get('checked'); if (chk === undefined) return false;
        }
        else if (psName === 'disabled') {
          if (!attrs.has('disabled')) return false;
        }
        else if (psName === 'enabled') {
          if (attrs.has('disabled')) return false;
        }
        else if (psName === 'required') {
          if (!attrs.has('required')) return false;
        }
        else if (psName === 'optional') {
          if (attrs.has('required')) return false;
        }
        else if (psName === 'placeholder-shown') {
          if (!attrs.has('placeholder')) return false;
        }
        // Link pseudo-classes
        else if (psName === 'link' || psName === 'any-link') {
          if (tag !== 'a' && tag !== 'area' && tag !== 'link') return false;
        }
        else if (psName === 'visited') {
          // can't tell — always miss to be safe
        }
        // Structural pseudo-classes — use sibling info when available
        else if (psName === 'first-child') {
          if (sibIdx !== undefined && sibIdx !== 0) return false;
        }
        else if (psName === 'last-child') {
          if (sibIdx !== undefined && sibCount !== undefined && sibIdx !== sibCount - 1) return false;
        }
        else if (psName === 'only-child') {
          if (sibCount !== undefined && sibCount !== 1) return false;
        }
        else if (psName === 'nth-child') {
          if (sibIdx !== undefined && psArg) {
            if (!_matchesNth(psArg, sibIdx + 1)) return false;
          }
        }
        else if (psName === 'nth-last-child') {
          if (sibIdx !== undefined && sibCount !== undefined && psArg) {
            if (!_matchesNth(psArg, sibCount - sibIdx)) return false;
          }
        }
        else if (psName === 'first-of-type' || psName === 'last-of-type' ||
                 psName === 'only-of-type' ||
                 psName === 'nth-of-type' || psName === 'nth-last-of-type') {
          // -of-type selectors need type-specific sibling info we don't have
          // optimistic: assume match
        }
        // :not() negation
        else if (psName === 'not' && psArg) {
          // if the argument selector matches, the element does NOT match :not()
          if (matchesCompound(tag, id, cls, attrs, psArg.trim())) return false;
        }
        // :is() / :where() / :has() — accept if any arg matches
        else if (psName === 'is' || psName === 'where') {
          var isArgs = psArg.split(',');
          var anyMatch = false;
          for (var ii = 0; ii < isArgs.length; ii++) {
            if (matchesCompound(tag, id, cls, attrs, isArgs[ii]!.trim())) { anyMatch = true; break; }
          }
          if (!anyMatch) return false;
        }
        else if (psName === 'has') {
          // :has() requires DOM tree — optimistic pass
        }
        // :root
        else if (psName === 'root') {
          if (tag !== 'html') return false;
        }
        // :empty — can't tell without children
        else if (psName === 'empty') { /* pass */ }
        else {
          // Unknown pseudo-class — conservative pass (don't reject)
        }
      } else {
        return false;
      }
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
    if (feature === 'prefers-color-scheme') return value === 'dark';  // JSOS uses dark theme
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
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
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
        // For @media — parse inner rules if query matches
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
            rules.push(...innerRules);
          }
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

    // Regular rule: selector(s) { declarations (may contain nested rules) }
    var selText = readUntil('{};');
    if (i >= css.length || css[i] !== '{') { i++; continue; }
    i++; // consume {

    // Read balanced block content (handles nested {})
    var blockStart = i;
    var blockDepth = 1;
    while (i < css.length && blockDepth > 0) {
      var bch = css[i]!;
      if (bch === '{') blockDepth++;
      else if (bch === '}') blockDepth--;
      if (blockDepth > 0) i++;
    }
    var fullBlock = css.slice(blockStart, i);
    if (i < css.length && css[i] === '}') i++; // consume }

    selText = selText.trim();
    if (!selText || !fullBlock.trim()) continue;

    // Check if block contains nested rules (CSS nesting: & .child { ... })
    if (fullBlock.indexOf('{') !== -1) {
      // Separate declarations from nested rules
      var decls = '';
      var ni = 0;
      while (ni < fullBlock.length) {
        // Skip whitespace
        while (ni < fullBlock.length && fullBlock[ni]! <= ' ') ni++;
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
            if (fullBlock[ni] === '{') nd2++;
            else if (fullBlock[ni] === '}') nd2--;
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
            rules.push(...nestedRules);
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
        var spec2 = 0;
        for (var si2 = 0; si2 < sels2.length; si2++) {
          var s3 = selectorSpecificity(sels2[si2]!);
          if (s3 > spec2) spec2 = s3;
        }
        rules.push({ sels: sels2, props, spec: spec2, order: rules.length });
      }
    } else {
      // No nesting — simple rule
      var props = parseDeclBlock(fullBlock);
      var sels  = splitSelectors(selText);
      var spec = 0;
      for (var si = 0; si < sels.length; si++) {
        var s2 = selectorSpecificity(sels[si]!);
        if (s2 > spec) spec = s2;
      }
      rules.push({ sels, props, spec, order: rules.length });
    }
  }

  // Pre-parse all selectors into structured form so matching avoids regex
  preParseSelectorRules(rules);
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
  var before = '';
  var after  = '';
  var beforeSpec = -1;
  var afterSpec  = -1;
  var candidates = index ? candidateRules(index, tag, id, cls) : sheets;
  for (var ri = 0; ri < candidates.length; ri++) {
    var rule = candidates[ri]!;
    if (!rule.props.content) continue;   // skip rules without content
    for (var si = 0; si < rule.sels.length; si++) {
      var sel = rule.sels[si]!.trim();
      // Only act on ::before / ::after pseudo-elements
      var pem = sel.match(/::?(before|after)\s*$/i);
      if (!pem) continue;
      // Strip pseudo-element suffix → check if host element matches
      var hostSel = sel.slice(0, sel.length - pem[0].length).trim() || '*';
      if (!matchesSingleSel(tag, id, cls, attrs, hostSel, ancestors, sibIdx, sibCount)) continue;
      var which = pem[1]!.toLowerCase();
      var resolved = _resolveContentValue(rule.props.content, attrs, counters);
      if (which === 'before' && rule.spec > beforeSpec) {
        before = resolved; beforeSpec = rule.spec;
      } else if (which === 'after' && rule.spec > afterSpec) {
        after = resolved;  afterSpec  = rule.spec;
      }
      break;  // only one selector per rule matches per pseudo
    }
  }
  return { before, after };
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

  // ── Choose candidate set: indexed fast-path or full linear scan ────────────
  var candidates: CSSRule[] = index
    ? candidateRules(index, tag, id, cls)
    : sheets;

  // ── Collect matching rules (with result cache for stable elements) ─────────
  // Cache key: tag + id + sorted-cls only — inlineStyle is intentionally
  // excluded so that elements with unique inline styles (e.g. style="left: Npx")
  // still get cache hits for their sheet-matched rules.
  // Cache is flushed (via flushCSSMatchCache) whenever sheets change.
  var _sortedCls = cls.length > 1 ? cls.slice().sort().join(' ') : (cls[0] || '');
  var _cacheKey = tag + '\x00' + id + '\x00' + _sortedCls;
  _cssMatchTotal++;
  var _cachedMatch = _cssMatchCache.get(_cacheKey);
  var matches: { props: CSSProps; spec: number; order: number }[];
  if (_cachedMatch) {
    _cssMatchHits++;
    matches = _cachedMatch;
  } else {
    // Build O(1) class lookup Set for this element.
    var _clsSet: Set<string> | null = cls.length > 0 ? new Set<string>(cls) : null;
    matches = [];
    for (var ri = 0; ri < candidates.length; ri++) {
      var rule = candidates[ri]!;
      // Hot path: use pre-parsed selectors (no regex) when available
      if (rule.parsedSels) {
        for (var si = 0; si < rule.parsedSels.length; si++) {
          if (matchesParsedSel(tag, id, cls, attrs, rule.parsedSels[si]!, ancestors, sibIdx, sibCount, _clsSet)) {
            var srcOrder = index ? rule.order : ri;
            matches.push({ props: rule.props, spec: rule.spec, order: srcOrder });
            break;
          }
        }
      } else {
        for (var si = 0; si < rule.sels.length; si++) {
          if (matchesSingleSel(tag, id, cls, attrs, rule.sels[si]!, ancestors, sibIdx, sibCount)) {
            var srcOrder = index ? rule.order : ri;
            matches.push({ props: rule.props, spec: rule.spec, order: srcOrder });
            break;
          }
        }
      }
    }
    // Sort by specificity then source order
    matches.sort((a, b) => a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);
    // Store in cache (bounded to 8192 entries)
    if (_cssMatchCache.size < 8192) {
      _cssMatchCache.set(_cacheKey, matches);
    }
  }

  // ── Apply normal rules in cascade order ───────────────────────────────────
  // !important rules are collected separately and applied after inline styles
  var importantRules: { props: CSSProps; spec: number; order: number }[] = [];
  for (var mi = 0; mi < matches.length; mi++) {
    var match = matches[mi]!;
    if (match.props.important && match.props.important.size > 0) {
      importantRules.push(match);
    }
    mergeProps(result, match.props);
    _applyKeywords(result, match.props, inherited);
  }

  // ── Inline style wins over normal sheet rules ──────────────────────────────
  if (inlineStyle) {
    var inlineParsed = parseInlineStyle(inlineStyle);
    mergeProps(result, inlineParsed);
    _applyKeywords(result, inlineParsed, inherited);
    // Inline !important overrides even !important sheet rules
    if (inlineParsed.important && inlineParsed.important.size > 0) {
      // already applied above — nothing more to do
    }
  }

  // ── !important sheet rules override inline normal style ───────────────────
  // (but NOT inline !important, which was already applied above)
  // Sort important rules same as normal rules
  importantRules.sort((a, b) => a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);
  for (var ii = 0; ii < importantRules.length; ii++) {
    mergeProps(result, importantRules[ii]!.props, importantRules[ii]!.props.important);
    _applyKeywords(result, importantRules[ii]!.props, inherited);
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
  var idx = buildRuleIndex(rules);
  // Debug: log how many rules landed in universalRules (checked for EVERY element)
  if (typeof os !== 'undefined' && os && os.debug) {
    os.debug.log('[browser] ruleIndex: rules=' + rules.length +
      ' universalRules=' + idx.universalRules.length +
      ' classBuckets=' + idx.classBuckets.size +
      ' tagBuckets='   + idx.tagBuckets.size +
      ' idBuckets='    + idx.idBuckets.size);
  }
  return idx;
}

function mergeProps(target: CSSProps, src: CSSProps, importantOnly?: Set<string>): void {
  // Helper: only apply if no existing !important blocks it, and if we're
  // allowed to apply (either it's not guarded by importantOnly, or it IS important).
  function set<K extends keyof CSSProps>(k: K, v: CSSProps[K]): void {
    if (v === undefined) return;
    if (importantOnly && !importantOnly.has(k as string)) return;
    // Don't overwrite a target value that was set by !important in a later rule
    // (handled by the cascade ordering — sort ensures higher-spec goes last)
    (target as Record<string, unknown>)[k as string] = v;
  }
  // ── Text ──────────────────────────────────────────────────────────────────
  set('color', src.color); set('bgColor', src.bgColor);
  set('bold', src.bold); set('italic', src.italic);
  set('underline', src.underline); set('strike', src.strike);
  set('align', src.align); set('hidden', src.hidden);
  set('fontScale', src.fontScale); set('fontFamily', src.fontFamily);
  set('fontWeight', src.fontWeight); set('lineHeight', src.lineHeight);
  set('letterSpacing', src.letterSpacing); set('wordSpacing', src.wordSpacing);
  set('textTransform', src.textTransform); set('textDecoration', src.textDecoration);
  set('textOverflow', src.textOverflow); set('whiteSpace', src.whiteSpace);
  set('verticalAlign', src.verticalAlign); set('listStyleType', src.listStyleType);
  // ── Box model ─────────────────────────────────────────────────────────────
  set('display', src.display); set('boxSizing', src.boxSizing);
  set('width', src.width); set('height', src.height);
  set('minWidth', src.minWidth); set('minHeight', src.minHeight);
  set('maxWidth', src.maxWidth); set('maxHeight', src.maxHeight);
  set('paddingTop', src.paddingTop); set('paddingRight', src.paddingRight);
  set('paddingBottom', src.paddingBottom); set('paddingLeft', src.paddingLeft);
  set('marginTop', src.marginTop); set('marginRight', src.marginRight);
  set('marginBottom', src.marginBottom); set('marginLeft', src.marginLeft);
  set('indent', src.indent);
  // ── Border ────────────────────────────────────────────────────────────────
  set('borderWidth', src.borderWidth); set('borderStyle', src.borderStyle);
  set('borderColor', src.borderColor); set('borderRadius', src.borderRadius);
  set('borderTopLeftRadius', src.borderTopLeftRadius);
  set('borderTopRightRadius', src.borderTopRightRadius);
  set('borderBottomRightRadius', src.borderBottomRightRadius);
  set('borderBottomLeftRadius', src.borderBottomLeftRadius);
  set('outlineWidth', src.outlineWidth); set('outlineColor', src.outlineColor);
  // ── Visual ────────────────────────────────────────────────────────────────
  set('opacity', src.opacity); set('boxShadow', src.boxShadow);
  set('textShadow', src.textShadow);
  // ── Positioning ───────────────────────────────────────────────────────────
  set('position', src.position); set('top', src.top); set('right', src.right);
  set('bottom', src.bottom); set('left', src.left); set('zIndex', src.zIndex);
  set('float', src.float); set('clear', src.clear);
  set('overflow', src.overflow);
  set('overflowX', src.overflowX); set('overflowY', src.overflowY);
  // ── Transform / transition ────────────────────────────────────────────────
  set('transform', src.transform); set('transformOrigin', src.transformOrigin);
  set('transition', src.transition); set('animation', src.animation);
  set('transitionProperty', src.transitionProperty);
  set('transitionDuration', src.transitionDuration);
  set('transitionTimingFunction', src.transitionTimingFunction);
  set('transitionDelay', src.transitionDelay);
  set('animationName', src.animationName);
  set('animationDuration', src.animationDuration);
  set('animationTimingFunction', src.animationTimingFunction);
  set('animationDelay', src.animationDelay);
  set('animationIterationCount', src.animationIterationCount);
  set('animationDirection', src.animationDirection);
  set('animationFillMode', src.animationFillMode);
  set('animationPlayState', src.animationPlayState);
  // ── Cursor / pointer ──────────────────────────────────────────────────────
  set('cursor', src.cursor); set('pointerEvents', src.pointerEvents);
  // ── Flexbox ───────────────────────────────────────────────────────────────
  set('flexDirection', src.flexDirection); set('flexWrap', src.flexWrap);
  set('justifyContent', src.justifyContent); set('alignItems', src.alignItems);
  set('alignContent', src.alignContent); set('flexGrow', src.flexGrow);
  set('flexShrink', src.flexShrink); set('flexBasis', src.flexBasis);
  set('alignSelf', src.alignSelf); set('order', src.order);
  set('gap', src.gap); set('rowGap', src.rowGap); set('columnGap', src.columnGap);
  // ── Grid ──────────────────────────────────────────────────────────────────
  set('gridTemplateColumns', src.gridTemplateColumns);
  set('gridTemplateRows', src.gridTemplateRows);
  set('gridTemplateAreas', src.gridTemplateAreas);
  set('gridAutoColumns', src.gridAutoColumns);
  set('gridAutoRows', src.gridAutoRows);
  set('gridAutoFlow', src.gridAutoFlow);
  set('gridColumn', src.gridColumn); set('gridRow', src.gridRow);
  set('gridColumnStart', src.gridColumnStart); set('gridColumnEnd', src.gridColumnEnd);
  set('gridRowStart', src.gridRowStart); set('gridRowEnd', src.gridRowEnd);
  set('gridArea', src.gridArea);
  set('justifyItems', src.justifyItems); set('justifySelf', src.justifySelf);
  set('placeItems', src.placeItems); set('placeContent', src.placeContent);
  set('placeSelf', src.placeSelf);
  // ── Background ────────────────────────────────────────────────────────────
  set('backgroundImage', src.backgroundImage); set('backgroundSize', src.backgroundSize);
  set('backgroundPosition', src.backgroundPosition); set('backgroundRepeat', src.backgroundRepeat);
  set('backgroundAttachment', src.backgroundAttachment); set('backgroundClip', src.backgroundClip);
  set('backgroundOrigin', src.backgroundOrigin);
  // ── Text wrapping / table / visibility ───────────────────────────────────
  set('wordBreak', src.wordBreak); set('overflowWrap', src.overflowWrap);
  set('lineBreak', src.lineBreak); set('tabSize', src.tabSize);
  set('tableLayout', src.tableLayout); set('borderCollapse', src.borderCollapse);
  set('borderSpacing', src.borderSpacing);
  set('visibility', src.visibility);
  set('userSelect', src.userSelect); set('appearance', src.appearance);
  set('caretColor', src.caretColor); set('accentColor', src.accentColor);
  set('fontStretch', src.fontStretch);
  set('outlineStyle', src.outlineStyle); set('outlineOffset', src.outlineOffset);
  set('listStylePosition', src.listStylePosition); set('listStyleImage', src.listStyleImage);
  set('content', src.content);
  set('counterReset', src.counterReset); set('counterIncrement', src.counterIncrement);
  // ── Image / media ──────────────────────────────────────────────────────────────
  set('objectFit', src.objectFit); set('objectPosition', src.objectPosition);
  set('aspectRatio', src.aspectRatio); set('imageRendering', src.imageRendering);
  // ── Multi-column ──────────────────────────────────────────────────────────────
  set('columnCount', src.columnCount); set('columnWidth', src.columnWidth);
  // ── Text (extended) ───────────────────────────────────────────────────────────
  set('textIndent', src.textIndent); set('textAlignLast', src.textAlignLast);
  set('fontVariant', src.fontVariant); set('fontKerning', src.fontKerning);
  set('hyphens', src.hyphens); set('lineClamp', src.lineClamp); set('quotes', src.quotes);
  // ── Layout / interaction helpers ──────────────────────────────────────────────
  set('isolation', src.isolation); set('touchAction', src.touchAction);
  set('colorScheme', src.colorScheme);
  // ── SVG CSS ───────────────────────────────────────────────────────────────────
  set('fill', src.fill); set('stroke', src.stroke); set('strokeWidth', src.strokeWidth);
  // ── Visual effects ───────────────────────────────────────────────────────────
  set('filter', src.filter); set('clipPath', src.clipPath);
  set('backdropFilter', src.backdropFilter); set('mixBlendMode', src.mixBlendMode);
  set('resize', src.resize); set('willChange', src.willChange); set('contain', src.contain);
}
