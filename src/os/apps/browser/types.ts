import type { PixelColor } from '../../core/sdk.js';

// ── URL ───────────────────────────────────────────────────────────────────────

export interface ParsedURL {
  protocol: 'http' | 'https' | 'about' | 'data';
  host: string;
  port: number;
  path: string;
  raw: string;
  dataMediaType?: string;  // for data: URLs
  dataBody?: string;       // raw data content (base64 or percent-encoded)
}

// ── Inline content ────────────────────────────────────────────────────────────

export interface InlineSpan {
  text:       string;
  href?:      string;
  download?:  string;  // <a download="filename"> hint (item 636)
  bold?:      boolean;
  italic?:    boolean;
  code?:      boolean;
  del?:       boolean;
  mark?:      boolean;
  underline?: boolean;
  color?:     number;   // explicit CSS color (ARGB)
  fontScale?: number;  // pixel-scale factor (1=8px, 2=16px, 3=24px)
}

export type BlockType =
  | 'block' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'hr' | 'li' | 'pre' | 'p-break' | 'blockquote' | 'widget' | 'summary'
  | 'aside'        // float:right/left — rendered as a boxed indented block
  | 'flex-row'     // display:flex row — children rendered inline
  | 'grid'         // display:grid — CSS Grid container (items 404-405)
  | 'grid-item'    // grid cell child node
  | 'table'        // <table> container node (item 449)
  | 'table-row'    // <tr> row — contains table-cell children
  | 'table-cell';  // <td>/<th> — cell node

export interface RenderNode {
  type:         BlockType;
  spans:        InlineSpan[];
  indent?:      number;
  widget?:      WidgetBlueprint;
  textAlign?:   'left' | 'center' | 'right' | 'justify';
  bgColor?:     number;    // CSS background-color (ARGB)
  bgGradient?:  string;    // CSS gradient string: linear/radial/conic-gradient(...) (item 487)
  bgImage?:     string;    // CSS background-image url(...) extracted URL (item 386)
  float?:       'left' | 'right';
  marginTop?:   number;    // px — extra space before block
  marginBottom?: number;   // px — extra space after block
  marginLeft?:  number;    // px — left margin
  marginRight?: number;    // px — right margin
  paddingLeft?:  number;   // px — left indent for block content
  paddingRight?: number;
  paddingTop?:   number;
  paddingBottom?: number;
  boxWidth?:    number;    // px — constrained column width (0=full)
  children?:    RenderNode[];  // sub-nodes (flex-row children)
  // Extended CSS box model
  height?:       number;
  minHeight?:    number;
  maxHeight?:    number;
  borderRadius?: number;
  borderWidth?:  number;
  borderColor?:  number;
  borderStyle?:  string;
  opacity?:      number;
  boxShadow?:    string;
  // Positioning
  position?:     'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  posTop?:       number;
  posRight?:     number;
  posBottom?:    number;
  posLeft?:      number;
  zIndex?:       number;
  overflow?:     'visible' | 'hidden' | 'scroll' | 'auto';
  // Text presentation
  whiteSpace?:   'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  lineHeight?:   number;
  // Flex container
  flexDirection?:  'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap?:       'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent?: string;
  alignItems?:     string;
  gap?:            number;
  // Flex child
  flexGrow?:    number;
  flexShrink?:  number;
  order?:       number;
  alignSelf?:   string;
  // Clear floats (item 400)
  clear?:       'left' | 'right' | 'both' | 'none';
  // Box sizing (item 448)
  boxSizing?:   'content-box' | 'border-box';
  // Block formatting context root (item 441)
  bfcRoot?:     boolean;
  // Table (item 449)
  tableLayout?:    'auto' | 'fixed';
  borderCollapse?: 'separate' | 'collapse';  // item 419
  borderSpacing?:  number;                   // item 419
  verticalAlign?:  string;                   // item 420
  wordBreak?:      string;                   // item 421
  overflowWrap?:   string;                   // item 421
  colspan?:        number;
  rowspan?:        number;
  // CSS Grid container (items 404-405)
  gridTemplateColumns?: string;  // raw track template string (e.g. '1fr 200px repeat(3,1fr)')
  gridTemplateRows?:    string;
  gridTemplateAreas?:   string;
  gridAutoColumns?:     string;
  gridAutoRows?:        string;
  gridAutoFlow?:        string;
  rowGap?:              number;
  columnGap?:           number;
  justifyItems?:        string;
  // Grid item placement
  gridColumn?:          string;   // shorthand 'start / end'
  gridRow?:             string;   // shorthand 'start / end'
  gridColumnStart?:     string;
  gridColumnEnd?:       string;
  gridRowStart?:        string;
  gridRowEnd?:          string;
  gridArea?:            string;
  // Cursor / interaction (items 415, 416)
  cursor?:        string;              // CSS cursor value: auto, pointer, text, crosshair, move,…
  pointerEvents?: 'auto' | 'none';    // CSS pointer-events: none disables mouse events on element
}

// ── Rendered output ───────────────────────────────────────────────────────────

export interface RenderedSpan {
  x:          number;
  text:       string;
  color:      PixelColor;
  href?:      string;
  download?:  string;  // <a download="filename"> hint (item 636)
  bold?:      boolean;
  italic?:    boolean;   // CSS font-style: italic/oblique (item 433)
  del?:       boolean;
  mark?:      boolean;
  codeBg?:    boolean;
  underline?: boolean;
  searchHit?: boolean;
  hitIdx?:    number;
  fontScale?: number;  // pixel-scale factor for scaled text rendering
}

export interface RenderedLine {
  y:         number;
  nodes:     RenderedSpan[];
  lineH:     number;
  preBg?:    boolean;
  quoteBg?:  boolean;
  quoteBar?: boolean;
  hrLine?:   boolean;
  bgColor?:    number;   // custom background from CSS
  bgGradient?: string;   // CSS gradient string (item 487): linear/radial/conic-gradient(...)
  bgImageUrl?:  string;   // CSS background-image url() resolved URL (item 386)
}

// ── Navigation ────────────────────────────────────────────────────────────────

export interface HistoryEntry { url: string; title: string; }

// ── Widgets / Forms ───────────────────────────────────────────────────────────

export type WidgetKind =
  | 'text' | 'password' | 'submit' | 'reset' | 'button'
  | 'checkbox' | 'radio' | 'select' | 'textarea' | 'file' | 'hidden'
  | 'img';

export interface WidgetBlueprint {
  kind:       WidgetKind;
  name:       string;
  value:      string;
  checked:    boolean;
  disabled:   boolean;
  readonly:   boolean;
  formIdx:    number;       // index into FormState[]
  options?:   string[];     // select option labels
  optVals?:   string[];     // select option values
  selIdx?:    number;       // initially selected option
  rows?:      number;       // textarea rows
  cols?:      number;       // textarea cols / input size
  imgSrc?:    string;       // img src
  imgAlt?:    string;
  imgNatW?:   number;       // natural width from HTML attr
  imgNatH?:   number;
  radioGroup?: string;      // name used for radio grouping
  // ── Form validation attributes (item 603) ─────────────────────────────────
  required?:   boolean;     // field must not be empty on submit
  minLength?:  number;      // minimum character count
  maxLength?:  number;      // maximum character count
  pattern?:    string;      // regex pattern (without delimiters)
  inputMin?:   string;      // min value (for number/date inputs)
  inputMax?:   string;      // max value (for number/date inputs)
  inputType?:  string;      // original input type attr (email, url, number, tel)
  placeholder?: string;     // hint text shown when empty
  /** Pre-decoded image for SVG inline (item 371): bypasses network fetch. */
  preloadedImage?: DecodedImage | null;
}

/** A widget after layout — knows its position in page space. */
export interface PositionedWidget extends WidgetBlueprint {
  id:   number;
  px:   number;   // page x
  py:   number;   // page y
  pw:   number;   // width
  ph:   number;   // height
  // mutable runtime state
  curValue:   string;
  curChecked: boolean;
  curSelIdx:  number;
  cursorPos:  number;   // text cursor
  imgData:    Uint32Array | null;
  imgLoaded:  boolean;
}

export interface FormState {
  action:  string;
  method:  'get' | 'post';
  enctype: string;
}

// ── Images ────────────────────────────────────────────────────────────────────

export interface DecodedImage {
  w:    number;
  h:    number;
  data: Uint32Array | null;  // 0xAARRGGBB pixels, null = decode failed
}

// ── HTML tokeniser ────────────────────────────────────────────────────────────

export interface HtmlToken {
  kind:  'text' | 'open' | 'close' | 'self';
  tag:   string;
  text:  string;
  attrs: Map<string, string>;
}

// ── HTML parser output ────────────────────────────────────────────────────────

export interface ScriptRecord {
  inline: boolean;
  src:    string;   // URL for external
  code:   string;   // source for inline
  type:   string;   // mime-type
}

export interface ParseResult {
  nodes:      RenderNode[];
  title:      string;
  forms:      FormState[];
  widgets:    WidgetBlueprint[];
  baseURL:    string;
  scripts:    ScriptRecord[];
  /** Raw text of all <style> blocks collected from this page (in source order). */
  styles:     string[];
  /** Href values of <link rel="stylesheet"> tags (for external fetch). */
  styleLinks: string[];
  /** True when no valid DOCTYPE is present (item 349). */
  quirksMode?: boolean;
  /** Named template fragments from <template> elements (item 357). Key = template id. */
  templates?: Map<string, RenderNode[]>;
  /** Href from first <link rel="icon"> or <link rel="shortcut icon"> (item 628). */
  favicon?: string;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

export interface CSSProps {
  // ── Text ──────────────────────────────────────────────────────────────────
  color?:         number;
  bgColor?:       number;
  bold?:          boolean;
  italic?:        boolean;
  underline?:     boolean;
  strike?:        boolean;
  align?:         'left' | 'center' | 'right' | 'justify';
  hidden?:        boolean;
  fontScale?:     number;    // text magnification: 0.75 | 1 | 2 | 3
  fontFamily?:    string;
  fontWeight?:    number;    // 100–900 (400=normal, 700=bold)
  lineHeight?:    number;    // px
  letterSpacing?: number;    // px
  wordSpacing?:   number;    // px
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  textDecoration?: string;   // 'none' | 'underline' | 'line-through' | 'overline'
  textOverflow?:  'clip' | 'ellipsis';
  whiteSpace?:    'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  verticalAlign?: string;
  listStyleType?: string;
  // ── Box model ─────────────────────────────────────────────────────────────
  display?:       'flex' | 'inline-flex' | 'grid' | 'inline-block' | 'inline' | 'block' | 'none' | 'table' | 'table-row' | 'table-cell';
  boxSizing?:     'content-box' | 'border-box';
  width?:         number;    // px (0 = auto)
  height?:        number;    // px (0 = auto)
  minWidth?:      number;
  minHeight?:     number;
  maxWidth?:      number;
  maxHeight?:     number;
  paddingTop?:    number;
  paddingRight?:  number;
  paddingBottom?: number;
  paddingLeft?:   number;
  marginTop?:     number;
  marginRight?:   number;
  marginBottom?:  number;
  marginLeft?:    number;
  indent?:        number;    // derived: paddingLeft / CHAR_W
  // ── Border ────────────────────────────────────────────────────────────────
  borderWidth?:   number;
  borderStyle?:   string;
  borderColor?:   number;
  borderRadius?:  number;
  borderTopLeftRadius?:     number;
  borderTopRightRadius?:    number;
  borderBottomLeftRadius?:  number;
  borderBottomRightRadius?: number;
  outlineWidth?:  number;
  outlineColor?:  number;
  // ── Visual ────────────────────────────────────────────────────────────────
  opacity?:         number;    // 0..1 (undefined = fully opaque)
  boxShadow?:       string;
  textShadow?:      string;
  filter?:          string;    // CSS filter() functions
  clipPath?:        string;    // clip-path geometry
  backdropFilter?:  string;    // backdrop-filter functions
  mixBlendMode?:    string;    // mix-blend-mode
  resize?:          'none' | 'both' | 'horizontal' | 'vertical';
  willChange?:      string;    // compositing hint
  contain?:         string;    // CSS contain
  // ── Positioning ───────────────────────────────────────────────────────────
  position?:      'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  top?:           number;
  right?:         number;
  bottom?:        number;
  left?:          number;
  zIndex?:        number;
  float?:         'left' | 'right' | 'none';
  overflow?:      'visible' | 'hidden' | 'scroll' | 'auto';
  overflowX?:     'visible' | 'hidden' | 'scroll' | 'auto';
  overflowY?:     'visible' | 'hidden' | 'scroll' | 'auto';
  // ── Transform / transition / animation ───────────────────────────────────
  transform?:       string;
  transformOrigin?: string;   // e.g. '50% 50%', 'top left'
  transition?:      string;   // shorthand
  transitionProperty?:        string;
  transitionDuration?:        string;
  transitionTimingFunction?:  string;
  transitionDelay?:           string;
  animation?:       string;   // shorthand
  animationName?:             string;
  animationDuration?:         string;
  animationTimingFunction?:   string;
  animationDelay?:            string;
  animationIterationCount?:   string;
  animationDirection?:        string;
  animationFillMode?:         string;
  animationPlayState?:        string;
  // ── Cursor / pointer ──────────────────────────────────────────────────────
  cursor?:        string;
  pointerEvents?: 'auto' | 'none';
  clear?:         'left' | 'right' | 'both' | 'none';
  // ── Flexbox ───────────────────────────────────────────────────────────────
  flexDirection?:  'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap?:       'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent?: string;
  alignItems?:     string;
  alignContent?:   string;
  flexGrow?:       number;
  flexShrink?:     number;
  flexBasis?:      number;   // px; 0 = auto
  alignSelf?:      string;
  order?:          number;
  gap?:            number;
  rowGap?:         number;
  columnGap?:      number;
  // ── Grid ──────────────────────────────────────────────────────────────────
  gridTemplateColumns?: string;
  gridTemplateRows?:    string;
  gridTemplateAreas?:   string;
  gridAutoColumns?:     string;
  gridAutoRows?:        string;
  gridAutoFlow?:        string;
  gridColumn?:          string;
  gridRow?:             string;
  gridColumnStart?:     string;
  gridColumnEnd?:       string;
  gridRowStart?:        string;
  gridRowEnd?:          string;
  gridArea?:            string;
  justifyItems?:        string;
  justifySelf?:         string;
  placeItems?:          string;
  placeContent?:        string;
  placeSelf?:           string;
  // ── Background ────────────────────────────────────────────────────────────
  backgroundImage?:      string;
  backgroundSize?:       string;
  backgroundPosition?:   string;
  backgroundRepeat?:     string;
  backgroundAttachment?: string;   // scroll | fixed | local
  backgroundClip?:       string;   // border-box | padding-box | content-box | text
  backgroundOrigin?:     string;   // border-box | padding-box | content-box
  // ── Text overflow / wrapping ──────────────────────────────────────────────
  wordBreak?:       'normal' | 'break-all' | 'break-word' | 'keep-all';
  overflowWrap?:    'normal' | 'break-word' | 'anywhere';
  lineBreak?:       string;
  tabSize?:         number;
  // ── Table ─────────────────────────────────────────────────────────────────
  tableLayout?:     'auto' | 'fixed';
  borderCollapse?:  'separate' | 'collapse';
  borderSpacing?:   number;   // px
  // ── Visibility / interaction ──────────────────────────────────────────────
  visibility?:      'visible' | 'hidden' | 'collapse';
  userSelect?:      'none' | 'text' | 'all' | 'auto';
  appearance?:      string;
  caretColor?:      number;   // ARGB — input caret color
  accentColor?:     number;   // ARGB — form control accent color
  // ── Font extended ─────────────────────────────────────────────────────────
  fontStretch?:     string;   // condensed | expanded | normal etc.
  // ── Outline extended ──────────────────────────────────────────────────────
  outlineStyle?:    string;
  outlineOffset?:   number;
  // ── List style ────────────────────────────────────────────────────────────
  listStylePosition?: 'inside' | 'outside';
  listStyleImage?:    string;
  // ── Generated content / counters ─────────────────────────────────────────
  content?:           string;   // CSS content property (for ::before/::after)
  counterReset?:      string;   // counter-reset: name [initial]
  counterIncrement?:  string;   // counter-increment: name [step]
  // ── Image / media ────────────────────────────────────────────────────────
  objectFit?:       'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
  objectPosition?:  string;
  aspectRatio?:     string;    // e.g. '16/9', 'auto', '1'
  imageRendering?:  string;
  // ── Multi-column ─────────────────────────────────────────────────────────
  columnCount?:     number | 'auto';
  columnWidth?:     number | 'auto';
  // ── Text (extended) ──────────────────────────────────────────────────────
  textIndent?:      number;    // px
  textAlignLast?:   'auto' | 'left' | 'center' | 'right' | 'justify' | 'start' | 'end';
  fontVariant?:     string;    // normal | small-caps | etc.
  fontKerning?:     'auto' | 'normal' | 'none';
  hyphens?:         'none' | 'manual' | 'auto';
  lineClamp?:       number;    // -webkit-line-clamp
  quotes?:          string;
  // ── Layout / interaction helpers ─────────────────────────────────────────
  isolation?:       'auto' | 'isolate';
  touchAction?:     string;
  colorScheme?:     string;
  // ── SVG CSS properties ────────────────────────────────────────────────────
  fill?:            string;
  stroke?:          string;
  strokeWidth?:     number;
  // ── !important tracking (set of property names that carried !important) ──
  important?:     Set<string>;
  // ── Global keyword tracking for cascade resolution ──────────────────────
  _inherit?:      Set<string>;  // CSS prop names flagged 'inherit' or 'unset' (inheritable)
  _initial?:      Set<string>;  // CSS prop names flagged 'initial' or 'revert'
  // ── Pseudo-element content (resolved during HTML parsing, not cascade) ───
  _pseudoBefore?: string;  // resolved text of ::before { content: "..." }
  _pseudoAfter?:  string;  // resolved text of ::after  { content: "..." }
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface LayoutResult {
  lines:   RenderedLine[];
  widgets: PositionedWidget[];
}
