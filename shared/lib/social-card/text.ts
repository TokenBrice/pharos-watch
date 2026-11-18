/**
 * Real-metric text fitting. Widths come from HarfBuzz on the same TTF bytes
 * Satori shapes with, and wrapping replays Satori's greedy line breaking, so a
 * spec is validated without running Satori: copy shrinks to a floor, then fails.
 */
import { SOCIAL_CARD_FONTS, SocialCardError, type SocialCardFace } from "./tokens";

/**
 * The slice of the harfbuzzjs API Satori shapes with. Both runtimes already
 * load it for Satori: Node through the package, the Worker through its alias.
 */
export interface HarfBuzzApi {
  createBlob(bytes: Uint8Array): unknown;
  createFace(blob: unknown, index: number): { upem: number };
  createFont(face: unknown): { setScale(x: number, y: number): void };
  createBuffer(): {
    addText(text: string): void;
    guessSegmentProperties(): void;
    getGlyphPositions(): readonly { x_advance: number }[];
    destroy(): void;
  };
  shape(font: unknown, buffer: unknown): void;
}

export interface SocialCardMeasurer {
  /** Satori's width of one break unit: shaped advances plus letterSpacing between its glyphs. */
  width(text: string, face: SocialCardFace, size: number, letterSpacing?: number): number;
}

/**
 * Faces load on first use, so a renderer bundles only the faces its templates
 * draw (the scorecard uses no serif); measuring a face without bytes throws.
 */
export function createSocialCardMeasurer(hb: HarfBuzzApi, fonts: Readonly<Partial<Record<SocialCardFace, Uint8Array>>>): SocialCardMeasurer {
  const faces = new Map<SocialCardFace, { font: unknown; upem: number }>();
  const load = (key: SocialCardFace) => {
    let entry = faces.get(key);
    if (!entry) {
      const bytes = fonts[key];
      if (!bytes) throw new SocialCardError(`no font bytes for ${key} (${SOCIAL_CARD_FONTS[key].file})`);
      const face = hb.createFace(hb.createBlob(bytes), 0);
      const font = hb.createFont(face);
      font.setScale(face.upem, face.upem);
      entry = { font, upem: face.upem };
      faces.set(key, entry);
    }
    return entry;
  };
  // Shaped advances in em per face and run; a width at any size is linear in them.
  const shaped = new Map<string, { em: number; glyphs: number }>();
  return {
    width(text, face, size, letterSpacing = 0) {
      const key = `${face}\u0000${text}`;
      let run = shaped.get(key);
      if (!run) {
        const { font, upem } = load(face);
        const buffer = hb.createBuffer();
        try {
          buffer.addText(text);
          buffer.guessSegmentProperties();
          hb.shape(font, buffer);
          const positions = buffer.getGlyphPositions();
          run = { em: positions.reduce((sum, glyph) => sum + glyph.x_advance, 0) / upem, glyphs: positions.length };
        } finally {
          buffer.destroy();
        }
        shaped.set(key, run);
      }
      return run.em * size + letterSpacing * Math.max(0, run.glyphs - 1);
    },
  };
}

// UAX #14 never breaks after spaces before closing punctuation, nor after an opening bracket or quote.
const GLUED_BEFORE = /^[)\]}!?,.:;/\u2019\u201D\u2026%]/;
const GLUED_AFTER = /[([{\u201C\u2018]$/;

/**
 * Soft-wrap units, each keeping its trailing space. Only breaks Satori
 * certainly allows are used (spaces, and UAX #14's break after a hyphen
 * before a letter), so a measured line count is never optimistic.
 */
function breakUnits(text: string): string[] {
  const units: string[] = [];
  for (const word of text.split(/(?<= )(?=[^ ])|(?<=\p{L}-)(?=\p{L})/u)) {
    const previous = units[units.length - 1];
    if (previous !== undefined && (GLUED_BEFORE.test(word) || GLUED_AFTER.test(previous.trimEnd()))) units[units.length - 1] = previous + word;
    else units.push(word);
  }
  return units;
}

/** Satori measures each UAX #14 segment on its own, so hyphen, dash and slash breaks split a unit's measurement too. */
const segments = (unit: string) => unit.split(/(?<=[-/])(?=\p{L})|(?<=\u2013)(?=\S)/u);

interface TextStyle {
  face: SocialCardFace;
  size: number;
  lineHeight: number;
  /** Tracking in em; Satori applies it between glyphs, not across break units. */
  tracking?: number;
}

/** Slack against sub-pixel differences between this model and Satori's own segmentation. */
const SAFETY = 2;

interface Wrapped {
  lines: number;
  /** A single unit wider than the column: Satori would overflow instead of wrapping. */
  overflows: boolean;
}

/** Satori's greedy flow: a unit wraps when it would end past the column, ignoring its trailing spaces. */
function wrap(measure: SocialCardMeasurer, text: string, style: TextStyle, width: number): Wrapped {
  const spacing = (style.tracking ?? 0) * style.size;
  const unitWidth = (value: string) => segments(value).reduce((sum, part) => sum + measure.width(part, style.face, style.size, spacing), 0);
  const limit = width - SAFETY;
  let lines = 1;
  let line = 0;
  let overflows = false;
  for (const [index, unit] of breakUnits(text).entries()) {
    const full = unitWidth(unit);
    const trimmed = unit.endsWith(" ") ? unitWidth(unit.trimEnd()) : full;
    if (trimmed > limit) overflows = true;
    if (index > 0 && line + full > limit + (full - trimmed)) {
      lines += 1;
      line = full;
    } else line += full;
  }
  return { lines, overflows };
}

/** Satori's line box: each line is round(size × lineHeight) tall. */
const lineBox = (style: TextStyle) => Math.round(style.size * style.lineHeight);

export interface Block {
  /** Field path for errors ("hook", "left.symbol"). */
  field: string;
  text: string;
  face: SocialCardFace;
  /** Candidate sizes, most generous first; the last is the floor. */
  sizes: readonly number[];
  lineHeight: number;
  tracking?: number;
  width: number;
  maxLines: number;
  /** Space above the block inside a stack. */
  gap?: number;
}

export interface FittedBlock extends Block, TextStyle {
  lines: number;
  height: number;
}

/** The largest size from `sizes[from]` down that fits the column and line limit, with its index. */
function place(measure: SocialCardMeasurer, block: Block, from: number): { fitted: FittedBlock; index: number } | null {
  for (let index = from; index < block.sizes.length; index += 1) {
    const style = { face: block.face, size: block.sizes[index], lineHeight: block.lineHeight, tracking: block.tracking };
    const { lines, overflows } = wrap(measure, block.text, style, block.width);
    if (!overflows && lines <= block.maxLines) return { fitted: { ...block, ...style, lines, height: lines * lineBox(style) }, index };
  }
  return null;
}

const tooLong = (where: string, block: Block) =>
  new SocialCardError(`${where} ${block.field}: "${block.text}" exceeds ${block.maxLines} line(s) of ${block.width}px even at ${block.sizes[block.sizes.length - 1]}px`);

/** Largest size at which `block` fits its column and line limit; throws at the floor. */
export function fitBlock(measure: SocialCardMeasurer, where: string, block: Block): FittedBlock {
  const placed = place(measure, block, 0);
  if (!placed) throw tooLong(where, block);
  return placed.fitted;
}

/**
 * Fits a vertical stack into `budget` px; `reserved` is the height of non-text
 * rows in the same column. Each block starts at its largest size that fits its
 * own width; while the stack is too tall, the tallest block that can still
 * shrink steps down, so one long headline gives way before a short hook does.
 */
export function fitStack(measure: SocialCardMeasurer, where: string, blocks: readonly Block[], budget: number, reserved = 0): FittedBlock[] {
  const placed = blocks.map((block) => {
    const first = place(measure, block, 0);
    if (!first) throw tooLong(where, block);
    return first;
  });
  for (;;) {
    const height = reserved + placed.reduce((sum, { fitted }, index) => sum + fitted.height + (index > 0 ? fitted.gap ?? 0 : 0), 0);
    if (height <= budget) return placed.map(({ fitted }) => fitted);
    let tallest = -1;
    placed.forEach(({ fitted, index }, position) => {
      if (index < blocks[position].sizes.length - 1 && (tallest < 0 || fitted.height > placed[tallest].fitted.height)) tallest = position;
    });
    const next = tallest < 0 ? null : place(measure, blocks[tallest], placed[tallest].index + 1);
    if (!next) throw new SocialCardError(`${where}: copy overflows its ${budget}px column by ${Math.ceil(height - budget)}px even at the floor sizes`);
    placed[tallest] = next;
  }
}
