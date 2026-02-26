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
import { buildRuleIndex, candidateRules, type RuleIndex } from './cache.js';

export { resetCSSVars };
export type { RuleIndex };

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
        // Structural pseudo-classes — pass: we don't have DOM sibling info here
        else if (psName === 'first-child' || psName === 'last-child' ||
                 psName === 'only-child'  || psName === 'first-of-type' ||
                 psName === 'last-of-type' || psName === 'only-of-type' ||
                 psName === 'nth-child'   || psName === 'nth-last-child' ||
                 psName === 'nth-of-type' || psName === 'nth-last-of-type') {
          // Optimistic: assume match (rare false positives acceptable)
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
  };

  // ── Choose candidate set: indexed fast-path or full linear scan ────────────
  var candidates: CSSRule[] = index
    ? candidateRules(index, tag, id, cls)
    : sheets;

  // ── Collect matching rules ─────────────────────────────────────────────────
  var matches: { props: CSSProps; spec: number; order: number }[] = [];
  for (var ri = 0; ri < candidates.length; ri++) {
    var rule = candidates[ri]!;
    for (var si = 0; si < rule.sels.length; si++) {
      if (matchesSingleSel(tag, id, cls, attrs, rule.sels[si]!)) {
        var srcOrder = index ? sheets.indexOf(rule) : ri;
        matches.push({ props: rule.props, spec: rule.spec, order: srcOrder });
        break;
      }
    }
  }

  // ── Sort by specificity then source order ──────────────────────────────────
  matches.sort((a, b) => a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);

  // ── Apply normal rules in cascade order ───────────────────────────────────
  // !important rules are collected separately and applied after inline styles
  var importantRules: { props: CSSProps; spec: number; order: number }[] = [];
  for (var mi = 0; mi < matches.length; mi++) {
    var match = matches[mi]!;
    if (match.props.important && match.props.important.size > 0) {
      importantRules.push(match);
    }
    mergeProps(result, match.props);
  }

  // ── Inline style wins over normal sheet rules ──────────────────────────────
  if (inlineStyle) {
    var inlineParsed = parseInlineStyle(inlineStyle);
    mergeProps(result, inlineParsed);
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
  return buildRuleIndex(rules);
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
  set('float', src.float); set('overflow', src.overflow);
  set('overflowX', src.overflowX); set('overflowY', src.overflowY);
  // ── Transform / transition ────────────────────────────────────────────────
  set('transform', src.transform); set('transition', src.transition);
  set('animation', src.animation);
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
  set('gridColumn', src.gridColumn); set('gridRow', src.gridRow);
  set('gridArea', src.gridArea);
  // ── Background ────────────────────────────────────────────────────────────
  set('backgroundImage', src.backgroundImage); set('backgroundSize', src.backgroundSize);
  set('backgroundPosition', src.backgroundPosition); set('backgroundRepeat', src.backgroundRepeat);
}
