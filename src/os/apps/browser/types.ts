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
  | 'aside'       // float:right/left — rendered as a boxed indented block
  | 'flex-row';   // display:flex row — children rendered inline

export interface RenderNode {
  type:         BlockType;
  spans:        InlineSpan[];
  indent?:      number;
  widget?:      WidgetBlueprint;
  textAlign?:   'left' | 'center' | 'right';
  bgColor?:     number;    // CSS background-color (ARGB)
  float?:       'left' | 'right';
  marginTop?:   number;    // px — extra space before block
  marginBottom?: number;   // px — extra space after block
  paddingLeft?:  number;   // px — left indent for block content
  boxWidth?:    number;    // px — constrained column width (0=full)
  children?:    RenderNode[];  // sub-nodes (flex-row children)
}

// ── Rendered output ───────────────────────────────────────────────────────────

export interface RenderedSpan {
  x:          number;
  text:       string;
  color:      PixelColor;
  href?:      string;
  bold?:      boolean;
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
  bgColor?:  number;   // custom background from CSS
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
}

// ── CSS ───────────────────────────────────────────────────────────────────────

export interface CSSProps {
  color?:       number;
  bgColor?:     number;
  bold?:        boolean;
  italic?:      boolean;
  underline?:   boolean;
  strike?:      boolean;
  align?:       'left' | 'center' | 'right';
  hidden?:      boolean;
  // Layout
  float?:       'left' | 'right';
  display?:     'flex' | 'inline-flex' | 'grid' | 'inline-block' | 'inline' | 'block' | 'none';
  paddingLeft?: number;   // px
  paddingRight?: number;
  paddingTop?:  number;
  paddingBottom?: number;
  marginTop?:   number;
  marginBottom?: number;
  width?:       number;   // px (0 = auto)
  maxWidth?:    number;
  indent?:      number;   // derived: padding-left / CHAR_W
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface LayoutResult {
  lines:   RenderedLine[];
  widgets: PositionedWidget[];
}
