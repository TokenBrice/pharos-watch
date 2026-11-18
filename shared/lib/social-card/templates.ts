/**
 * The five lens-system templates (docs/og-images.md). Each returns a Satori
 * element for a 1200×630 canvas, or throws a SocialCardError naming the spec
 * path and field: budgets, glyph range and real-metric fit are checked while
 * the layout is built, so building the element is also the validation.
 */
import { PEG_BAND_HEX } from "../classification";
import { LIFECYCLE_STAMP_HEX } from "../classification/domain";
import { GRADE_ON_DARK_HEX } from "../classification/grades";
import { gradeRange } from "../report-card-core";
import { SAFETY_GRADE_VALUES, type SafetyGrade } from "../../types/report-card-grade";
import {
  at, chip, chipHeight, chipWidth, font, glyph, h, img, label, lens, lockup, logoChip, logoDisc, monogram, plate, shield,
  stamp, steps, svgUri, text, type SocialCardAssets, type SocialCardElement, type Style,
} from "./parts";
import type { SocialScorecardOverviewCard } from "./scorecard";
import type {
  SocialCardDossier, SocialCardHub, SocialCardHubSubject, SocialCardIdentity, SocialCardRecord, SocialCardSpec,
  SocialCardVersus, SocialScorecardCard,
} from "./spec";
import { fitBlock, fitStack, type Block, type FittedBlock } from "./text";
import { CARD_HEIGHT, CARD_WIDTH, COLUMN, DARK, FROST, LENS, PAPER, SOCIAL_CARD_LOGO_PATH, SocialCardError, drawable } from "./tokens";

const LABEL_MAX = 28;
/**
 * Body of a left column, below the lockup row (y 50-94). It ends at y 524
 * because X's 2:1 crop lays the domain overlay over x 23-295, y 536-592.
 */
const BODY = { top: 110, bottom: 524 } as const;
/** The depeg hub's price axis; its tick labels end before x 544 so the copy column keeps x 96-536. */
const PEG_RULER_X = 684;
const PEG_RULER_COPY = PEG_RULER_X - 140 - 8 - COLUMN.left;

function budget(where: string, field: string, value: string, max: number): string {
  const text = drawable(value, `${where} ${field}`);
  const length = [...text].length;
  if (length > max) throw new SocialCardError(`${where} ${field}: ${length} characters exceed the ${max}-character budget: "${text}"`);
  return text;
}

function count(where: string, field: string, items: readonly unknown[], min: number, max: number): void {
  if (items.length < min || items.length > max) throw new SocialCardError(`${where} ${field}: ${items.length} item(s), expected ${min}-${max}`);
}

function identity(where: string, field: string, value: SocialCardIdentity, symbolMax = 12): SocialCardIdentity {
  if (value.logoPath !== undefined && !SOCIAL_CARD_LOGO_PATH.test(value.logoPath)) {
    throw new SocialCardError(`${where} ${field}.logoPath: not a registered local logo: ${value.logoPath}`);
  }
  return { ...value, symbol: budget(where, `${field}.symbol`, value.symbol, symbolMax), name: budget(where, `${field}.name`, value.name, 80) };
}

function finite(where: string, field: string, value: number): number {
  if (!Number.isFinite(value)) throw new SocialCardError(`${where} ${field}: not a finite number`);
  return value;
}

function subject(where: string, value: SocialCardHubSubject): SocialCardHubSubject {
  switch (value.kind) {
    case "cluster":
      count(where, "subject.members", value.members, 1, 10);
      return { kind: "cluster", members: value.members.map((member, index) => identity(where, `subject.members[${index}]`, member)) };
    case "orbit":
      count(where, "subject.members", value.members, 0, 8);
      return { kind: "orbit", center: identity(where, "subject.center", value.center), members: value.members.map((member, index) => identity(where, `subject.members[${index}]`, member)) };
    case "peg-ruler": {
      count(where, "subject.lows", value.lows, 1, 6);
      const peg = finite(where, "subject.peg", value.peg);
      const floor = finite(where, "subject.floor", value.floor);
      if (!(floor >= 0 && floor < peg)) throw new SocialCardError(`${where} subject: floor ${floor} must sit below peg ${peg}`);
      return {
        ...value,
        currencySymbol: budget(where, "subject.currencySymbol", value.currencySymbol, 3),
        lows: value.lows.map((low, index) => {
          const price = finite(where, `subject.lows[${index}].price`, low.price);
          if (price < floor || price >= peg) throw new SocialCardError(`${where} subject.lows[${index}].price: ${price} is outside [${floor}, ${peg})`);
          return { identity: identity(where, `subject.lows[${index}].identity`, low.identity, 6), when: budget(where, `subject.lows[${index}].when`, low.when, 8), price };
        }),
      };
    }
    default:
      return value;
  }
}

/** Budgets, glyph range and structure; returns the spec with Satori-normalised text. */
export function normalizeSocialCardSpec(spec: SocialCardSpec): SocialCardSpec {
  const where = `Social card ${spec.path}`;
  const label = budget(where, "label", spec.label, LABEL_MAX);
  switch (spec.template) {
    case "hub":
      return { ...spec, label, headline: budget(where, "headline", spec.headline, 40), deck: budget(where, "deck", spec.deck, 90), subject: subject(where, spec.subject) };
    case "dossier": {
      count(where, "chips", spec.chips, 0, 2);
      if (spec.lifecycle === "active" && spec.stamp !== undefined) throw new SocialCardError(`${where} stamp: an active dossier carries no stamp`);
      return {
        ...spec, label,
        identity: identity(where, "identity", spec.identity, 60),
        headline: budget(where, "headline", spec.headline, 60),
        subline: budget(where, "subline", spec.subline, 48),
        hook: budget(where, "hook", spec.hook, 64),
        chips: spec.chips.map((value, index) => budget(where, `chips[${index}]`, value, 18)),
        stamp: spec.stamp === undefined ? undefined : budget(where, "stamp", spec.stamp, 24),
      };
    }
    case "versus":
      return {
        ...spec, label,
        left: { ...identity(where, "left", spec.left), detail: budget(where, "left.detail", spec.left.detail, 32) },
        right: { ...identity(where, "right", spec.right), detail: budget(where, "right.detail", spec.right.detail, 32) },
        hook: budget(where, "hook", spec.hook, 48),
      };
    case "record": {
      count(where, "facts", spec.facts ?? [], 0, 3);
      if (spec.ruler) {
        const { peg, floor, low } = spec.ruler;
        [peg, floor, low].forEach((value, index) => finite(where, `ruler.${["peg", "floor", "low"][index]}`, value));
        if (!(floor >= 0 && floor <= low && low < peg)) throw new SocialCardError(`${where} ruler: expected 0 <= floor <= low < peg, got ${floor} / ${low} / ${peg}`);
      }
      return {
        ...spec, label,
        identity: spec.identity && identity(where, "identity", spec.identity),
        dateline: spec.dateline === undefined ? undefined : budget(where, "dateline", spec.dateline, 32),
        title: budget(where, "title", spec.title, 90),
        dek: spec.dek === undefined ? undefined : budget(where, "dek", spec.dek, 150),
        pill: spec.pill && { ...spec.pill, text: budget(where, "pill.text", spec.pill.text, 16) },
        facts: spec.facts?.map((value, index) => budget(where, `facts[${index}]`, value, 40)),
        ruler: spec.ruler && { ...spec.ruler, currencySymbol: budget(where, "ruler.currencySymbol", spec.ruler.currencySymbol, 3) },
      };
    }
  }
}

const canvas = (background: string, ...children: (SocialCardElement | null | false)[]) =>
  h("div", { width: CARD_WIDTH, height: CARD_HEIGHT, position: "relative", background, overflow: "hidden" }, ...children);

/** The left copy column every dark template shares: lockup on top, body centred below. */
function column(top: SocialCardElement, body: (SocialCardElement | null)[]): SocialCardElement {
  return h("div", { ...at(COLUMN.left, 50, COLUMN.width, BODY.bottom - 50), flexDirection: "column" }, top,
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingTop: BODY.top - 94 }, ...body));
}

const placed = (blocks: FittedBlock[], colors: string[]) =>
  blocks.map((block, index) => text(block, colors[index] ?? DARK.text, { marginTop: index > 0 ? block.gap ?? 0 : 0 }));

/** A logo, or a dashed monogram when no logo is registered. */
function mark(assets: SocialCardAssets, value: SocialCardIdentity, size: number, where: string, options: { grey?: boolean; ring?: string } = {}): SocialCardElement {
  return value.logoPath
    ? logoDisc(assets, value.logoPath, size, { grey: options.grey, where })
    : monogram(assets.measure, value.symbol, size, options.ring ?? DARK.muted, where);
}

/** Clusters: an inner trio, then an outer ring that leaves the top free under the trio's lead. */
function cluster(assets: SocialCardAssets, members: readonly SocialCardIdentity[], where: string): SocialCardElement[] {
  const { cx, cy } = LENS;
  // A lone trio fills the lens; with an outer ring it tightens to make room.
  const [trioRadius, trioSize] = members.length === 3 ? [78, 116] : [64, 92];
  const spots: [number, number, number][] = members.length === 1 ? [[0, 0, 216]]
    : members.length === 2 ? [[-74, 0, 132], [74, 0, 132]]
      : [-90, 30, 150].map((degrees) => [trioRadius * Math.cos((degrees * Math.PI) / 180), trioRadius * Math.sin((degrees * Math.PI) / 180), trioSize] as [number, number, number]);
  const outer = members.length - 3;
  for (let index = 0; index < outer; index += 1) {
    const angle = -Math.PI / 2 + Math.PI / outer + (index / outer) * Math.PI * 2;
    spots.push([146 * Math.cos(angle), 146 * Math.sin(angle), 62]);
  }
  return members.map((member, index) => {
    const [x, y, size] = spots[index];
    return member.logoPath
      ? logoChip(assets, member.logoPath, cx + x, cy + y, size, where)
      : h("div", { ...at(cx + x - size / 2, cy + y - size / 2, size, size) }, monogram(assets.measure, member.symbol, size, DARK.muted, `${where} subject.members[${index}]`));
  });
}

function orbit(assets: SocialCardAssets, center: SocialCardIdentity, members: readonly SocialCardIdentity[], where: string): SocialCardElement[] {
  const { cx, cy } = LENS;
  return [
    plate(cx, cy, 92, { border: `1.5px solid ${DARK.lineStrong}` }),
    h("div", { ...at(cx - 84, cy - 84, 168, 168) }, mark(assets, center, 168, `${where} subject.center`)),
    ...members.map((member, index) => {
      const angle = -Math.PI / 2 + (index / members.length) * Math.PI * 2;
      const [x, y] = [cx + 146 * Math.cos(angle), cy + 146 * Math.sin(angle)];
      return member.logoPath
        ? logoChip(assets, member.logoPath, x, y, 62, where)
        : h("div", { ...at(x - 31, y - 31, 62, 62) }, monogram(assets.measure, member.symbol, 62, DARK.muted, `${where} subject.members[${index}]`));
    }),
  ];
}

const decimals = (value: number) => (String(value).split(".")[1] ?? "").length;
const money = (symbol: string, value: number, places: number) =>
  `${symbol}${value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toFixed(places)}`;

/** A fixed low as recorded, to three significant digits and at least cents: $0.879, $0.74, $0.012. */
const priceLabel = (symbol: string, price: number) => {
  const rounded = Number(price.toPrecision(3));
  return money(symbol, rounded, Math.min(4, Math.max(2, decimals(rounded))));
};

/** Round tick values from the floor up to the peg, labelled with the precision their step needs. */
function rulerTicks(peg: number, floor: number, symbol: string): { value: number; label: string }[] {
  const raw = (peg - floor) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ?? raw;
  const places = Math.max(2, decimals(Number(unit.toPrecision(2))));
  const ticks: { value: number; label: string }[] = [];
  for (let step = Math.floor(peg / unit + 1e-9); step * unit >= floor - unit * 1e-9; step -= 1) {
    ticks.push({ value: step * unit, label: money(symbol, step * unit, places) });
  }
  return ticks;
}
const isPeg = (value: number, peg: number) => Math.abs(value - peg) < 1e-9 * Math.max(1, peg);

/** Spreads labels at least `gap` apart inside [top, bottom], keeping their order. */
function spread(targets: readonly number[], gap: number, top: number, bottom: number): number[] {
  const ys = targets.map((value) => Math.max(top, value));
  for (let index = 1; index < ys.length; index += 1) ys[index] = Math.max(ys[index], ys[index - 1] + gap);
  ys[ys.length - 1] = Math.min(ys[ys.length - 1], bottom);
  for (let index = ys.length - 2; index >= 0; index -= 1) ys[index] = Math.min(ys[index], ys[index + 1] - gap);
  return ys;
}

/** Depeg hub: real closed lows on one shared scale; fixed history, never a live state. */
function pegRuler(assets: SocialCardAssets, value: Extract<SocialCardHubSubject, { kind: "peg-ruler" }>, where: string): SocialCardElement[] {
  const { measure } = assets;
  const top = 132;
  const bottom = 528;
  const y = (price: number) => top + ((value.peg - price) / (value.peg - value.floor)) * (bottom - top);
  const lows = [...value.lows].sort((a, b) => b.price - a.price);
  const sizes = [[24, 22], [22, 22]] as const;
  const rows = sizes.map(([symbolSize, detailSize]) => lows.map((low) => {
    const detail = `${low.when} · ${priceLabel(value.currencySymbol, low.price)}`;
    return { symbolSize, detailSize, detail, width: 36 + 10 + measure.width(low.identity.symbol, "mono-700", symbolSize) + 10 + measure.width(detail, "mono-500", detailSize) };
  }));
  const rx = PEG_RULER_X;
  const room = COLUMN.right - (rx + 58);
  const fitting = rows.find((row) => row.every((entry) => entry.width <= room));
  if (!fitting) throw new SocialCardError(`${where} subject.lows: a low label is wider than ${room}px at 22px`);
  const ys = spread(lows.map((low) => y(low.price)), 46, top + 22, bottom);
  const red = PEG_BAND_HEX.depeg;
  const ticks = rulerTicks(value.peg, value.floor, value.currencySymbol);
  const art = [
    `<path d="M${rx} ${top}V${bottom}" stroke="${DARK.lineStrong}" stroke-width="4" stroke-linecap="round"/>`,
    ...ticks.map((tick) => `<path d="M${rx - 16} ${y(tick.value)}H${rx}" stroke="${DARK.lineStrong}" stroke-width="2"/>`),
    `<path d="M${rx} ${top}H1200" stroke="${FROST}" stroke-width="3" stroke-dasharray="7 7"/>`,
    ...lows.map((low, index) => `<path d="M${rx} ${y(low.price)}H${rx + 26}L${rx + 40} ${ys[index]}H${rx + 52}" fill="none" stroke="${red}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="${rx}" cy="${y(low.price)}" r="10" fill="${red}"/>`),
  ].join("");
  return [
    img(svgUri(CARD_WIDTH, CARD_HEIGHT, art), CARD_WIDTH, at(0, 0, CARD_WIDTH, CARD_HEIGHT), CARD_HEIGHT),
    // The peg itself is labelled on its line, so its tick stays unlabelled.
    ...ticks.filter((tick) => !isPeg(tick.value, value.peg)).map((tick) => h("div", { ...at(rx - 140, y(tick.value) - 15, 114, 30), justifyContent: "flex-end", alignItems: "center" },
      label(measure, tick.label, "mono-500", 21, DARK.muted).node)),
    h("div", { ...at(rx + 58, top - 46, 400, 30), alignItems: "center" }, label(measure, `peg ${priceLabel(value.currencySymbol, value.peg)}`, "mono-500", 22, FROST).node),
    ...lows.map((low, index) => h("div", { ...at(rx + 58, ys[index] - 20, room, 40), alignItems: "center" },
      low.identity.logoPath ? logoDisc(assets, low.identity.logoPath, 36, { where }) : h("div", { width: 36, height: 36, borderRadius: 18, border: `2px dashed ${DARK.muted}` }),
      h("div", { marginLeft: 10 }, label(measure, low.identity.symbol, "mono-700", fitting[index].symbolSize, DARK.text).node),
      h("div", { marginLeft: 10 }, label(measure, fitting[index].detail, "mono-500", fitting[index].detailSize, DARK.muted).node))),
  ];
}

/** A–F grade families, coloured only from the classification authority. */
function gradeLegend(): SocialCardElement {
  return h("div", { marginTop: 30 }, ...(["A", "B", "C", "D", "F"] as const).map((family, index) => {
    const color = GRADE_ON_DARK_HEX[family];
    return h("div", { width: 60, height: 60, marginLeft: index > 0 ? 12 : 0, borderRadius: 14, border: `2.5px solid ${color}`, alignItems: "center", justifyContent: "center", ...font("display-800"), fontSize: 28, color }, family);
  }));
}

function hub(spec: SocialCardHub, assets: SocialCardAssets): SocialCardElement {
  const where = `Social card ${spec.path}`;
  const { measure } = assets;
  const ruler = spec.subject.kind === "peg-ruler";
  const legend = spec.subject.kind === "grade-shield";
  const [headline, deck] = fitStack(measure, where, [
    { field: "headline", text: spec.headline, face: "display-800", sizes: steps(96, 52, 4), lineHeight: 1, tracking: -0.035, width: ruler ? PEG_RULER_COPY : COLUMN.width, maxLines: 4 },
    { field: "deck", text: spec.deck, face: "display-400", sizes: steps(34, 26), lineHeight: 1.28, width: ruler ? PEG_RULER_COPY : COLUMN.width, maxLines: 3, gap: 24 },
  ], BODY.bottom - BODY.top, legend ? 90 : 0);
  const { cx, cy } = LENS;
  const art: SocialCardElement[] = [];
  switch (spec.subject.kind) {
    case "cluster":
      art.push(lens(cx, cy, LENS.r, { orbit: 146 }), ...cluster(assets, spec.subject.members, where));
      break;
    case "orbit":
      art.push(lens(cx, cy, LENS.r, { orbit: 146 }), ...orbit(assets, spec.subject.center, spec.subject.members, where));
      break;
    case "grade-shield":
      art.push(lens(cx, cy, LENS.r), shield(cx, cy),
        h("div", { ...at(cx - 135, cy - 125, 270, 230), justifyContent: "center", alignItems: "center", ...font("display-800"), fontSize: 170, lineHeight: 1, color: DARK.text }, "?"));
      break;
    case "peg-ruler":
      art.push(...pegRuler(assets, spec.subject, where));
      break;
    case "glyph":
      art.push(lens(cx, cy, LENS.r), plate(cx, cy, 140), glyph(spec.subject.glyph, cx, cy, 196));
      break;
  }
  return canvas(DARK.ground, ...art,
    column(lockup(assets, spec.label, "dark").node, [...placed([headline, deck], [DARK.text, DARK.muted]), legend ? gradeLegend() : null]));
}

/** Chip rows: one row when both fit, else stacked; shrinks before stacking. */
function chipRows(assets: SocialCardAssets, chips: readonly string[], where: string): { node: SocialCardElement | null; height: number } {
  if (chips.length === 0) return { node: null, height: 0 };
  for (const size of [23, 22]) {
    const widths = chips.map((value) => chipWidth(assets.measure, value, size));
    if (widths.reduce((sum, width) => sum + width, 0) + 10 * (chips.length - 1) <= COLUMN.width) {
      return { node: h("div", { marginTop: 28 }, ...chips.map((value, index) => h("div", { marginLeft: index > 0 ? 10 : 0 }, chip(value, size)))), height: 28 + chipHeight(size) };
    }
  }
  if (chips.some((value) => chipWidth(assets.measure, value, 23) > COLUMN.width)) throw new SocialCardError(`${where} chips: a chip is wider than the column`);
  return { node: h("div", { marginTop: 28, flexDirection: "column", alignItems: "flex-start" }, ...chips.map((value, index) => h("div", { marginTop: index > 0 ? 10 : 0 }, chip(value, 23)))), height: 28 + chips.length * chipHeight(23) + 10 * (chips.length - 1) };
}

function dossier(spec: SocialCardDossier, assets: SocialCardAssets): SocialCardElement {
  const where = `Social card ${spec.path}`;
  const { measure } = assets;
  const tickerHeadline = spec.headline === spec.identity.symbol;
  const tickerSubline = !tickerHeadline && spec.subline === spec.identity.symbol;
  const chips = chipRows(assets, spec.chips, where);
  const blocks: Block[] = [
    tickerHeadline
      ? { field: "headline", text: spec.headline, face: "display-800", sizes: steps(140, 64, 4), lineHeight: 0.96, tracking: -0.035, width: COLUMN.width, maxLines: 1 }
      : { field: "headline", text: spec.headline, face: "display-800", sizes: steps(84, 48, 4), lineHeight: 1, tracking: -0.03, width: COLUMN.width, maxLines: 3 },
    tickerSubline
      ? { field: "subline", text: spec.subline, face: "mono-500", sizes: steps(28, 22), lineHeight: 1.2, width: COLUMN.width, maxLines: 2, gap: 16 }
      : { field: "subline", text: spec.subline, face: "display-600", sizes: steps(32, 24), lineHeight: 1.2, width: COLUMN.width, maxLines: 2, gap: 14 },
    { field: "hook", text: spec.hook, face: "serif-italic-400", sizes: steps(44, 30), lineHeight: 1.12, width: COLUMN.width, maxLines: 3, gap: 22 },
  ];
  const fitted = fitStack(measure, where, blocks, BODY.bottom - BODY.top, chips.height);
  const { cx, cy } = LENS;
  const historical = spec.lifecycle === "historical";
  const tone = spec.lifecycle === "active" ? null : LIFECYCLE_STAMP_HEX[spec.lifecycle];
  return canvas(DARK.ground,
    lens(cx, cy, LENS.r),
    plate(cx, cy, 140),
    h("div", { ...at(cx - 108, cy - 108, 216, 216) }, mark(assets, spec.identity, 216, `${where} identity`, { grey: historical })),
    spec.stamp && tone ? stamp(spec.stamp, tone, cx, cy + 96) : null,
    column(lockup(assets, spec.label, "dark").node, [...placed(fitted, [DARK.text, DARK.muted, DARK.text]), chips.node]));
}

/**
 * Binoculars: two lenses bridged by a frost "vs", each logo fully inside the
 * centre square, ticker and detail centred under their own lens. The hook takes
 * one line beside the lockup so it never reaches the lenses.
 */
function versus(spec: SocialCardVersus, assets: SocialCardAssets): SocialCardElement {
  const where = `Social card ${spec.path}`;
  const { measure } = assets;
  const brand = lockup(assets, spec.label, "dark");
  const hookWidth = COLUMN.right - (COLUMN.left + brand.width + 48);
  const hook = fitBlock(measure, where, { field: "hook", text: spec.hook, face: "serif-italic-400", sizes: steps(32, 22), lineHeight: 1.15, width: hookWidth, maxLines: 1 });
  const cy = 254;
  const r = 132;
  const textWidth = 440;
  const sides = ([["left", spec.left, 380], ["right", spec.right, 820]] as const).map(([side, value, cx]) => ({
    side, value, cx,
    symbol: fitBlock(measure, where, { field: `${side}.symbol`, text: value.symbol, face: "display-800", sizes: steps(76, 40, 4), lineHeight: 1, tracking: -0.03, width: textWidth, maxLines: 1 }),
    detail: fitBlock(measure, where, { field: `${side}.detail`, text: value.detail, face: "mono-500", sizes: [22], lineHeight: 1.25, width: textWidth, maxLines: 1 }),
  }));
  // One size per row so the pair reads as equals.
  const symbolSize = Math.min(...sides.map((entry) => entry.symbol.size));
  const detailSize = Math.min(...sides.map((entry) => entry.detail.size));
  const reach = Math.ceil(r + 26 * (r / 205));
  const bridge = `<path d="M${380 + reach + 10} ${cy - 18}H${820 - reach - 10}M${380 + reach + 10} ${cy + 18}H${820 - reach - 10}" stroke="${DARK.lineStrong}" stroke-width="2"/>`;
  return canvas(DARK.ground,
    img(svgUri(CARD_WIDTH, CARD_HEIGHT, bridge), CARD_WIDTH, at(0, 0, CARD_WIDTH, CARD_HEIGHT), CARD_HEIGHT),
    ...sides.flatMap(({ value, cx, side }) => [
      lens(cx, cy, r, { dashed: false }),
      plate(cx, cy, r - 22),
      h("div", { ...at(cx - 90, cy - 90, 180, 180) }, mark(assets, value, 180, `${where} ${side}`)),
    ]),
    h("div", { ...at(600 - 40, cy - 40, 80, 80), borderRadius: 40, border: `3px solid ${FROST}`, background: DARK.ground, alignItems: "center", justifyContent: "center" },
      h("div", { ...font("mono-700"), fontSize: 30, lineHeight: 1, color: FROST, marginTop: -3 }, "vs")),
    ...sides.map(({ cx, symbol, detail }) => h("div", { ...at(cx - textWidth / 2, cy + reach + 12, textWidth, 130), flexDirection: "column", alignItems: "center" },
      text({ ...symbol, size: symbolSize }, DARK.text, { textAlign: "center", justifyContent: "center" }),
      text({ ...detail, size: detailSize }, DARK.muted, { marginTop: 12, textAlign: "center", justifyContent: "center" }))),
    h("div", { ...at(COLUMN.left, 50, COLUMN.right - COLUMN.left, 44), justifyContent: "space-between", alignItems: "center" },
      brand.node,
      text(hook, DARK.text, { width: hookWidth, textAlign: "right", justifyContent: "flex-end" })));
}

const RECORD_ACCENT = { severity: PEG_BAND_HEX.depeg, ink: PAPER.text, frost: FROST } as const;

function recordRuler(assets: SocialCardAssets, ruler: NonNullable<SocialCardRecord["ruler"]>): SocialCardElement[] {
  const { measure } = assets;
  const rx = 1000;
  const top = 168;
  const bottom = 532;
  const y = (price: number) => top + ((ruler.peg - price) / (ruler.peg - ruler.floor)) * (bottom - top);
  const red = PEG_BAND_HEX.depeg;
  const ticks = rulerTicks(ruler.peg, ruler.floor, ruler.currencySymbol);
  const art = [
    `<path d="M${rx} ${top}V${bottom}" stroke="${PAPER.line}" stroke-width="4" stroke-linecap="round"/>`,
    ...ticks.map((tick) => `<path d="M${rx - 18} ${y(tick.value)}H${rx}" stroke="${PAPER.muted}" stroke-width="2"/>`),
    `<path d="M${rx} ${top}H1200" stroke="${FROST}" stroke-width="3" stroke-dasharray="6 6"/>`,
    `<path d="M${rx} ${top}V${y(ruler.low)}" stroke="${red}" stroke-width="10" stroke-linecap="round"/><circle cx="${rx}" cy="${y(ruler.low)}" r="13" fill="${red}"/>`,
  ].join("");
  const lowY = y(ruler.low);
  return [
    img(svgUri(CARD_WIDTH, CARD_HEIGHT, art), CARD_WIDTH, at(0, 0, CARD_WIDTH, CARD_HEIGHT), CARD_HEIGHT),
    ...ticks.map((tick) => h("div", { ...at(rx - 150, y(tick.value) - 15, 124, 30), justifyContent: "flex-end", alignItems: "center" },
      label(measure, tick.label, "mono-500", 21, PAPER.muted).node)),
    h("div", { ...at(rx + 26, top - 44, 160, 30), alignItems: "center" }, label(measure, "peg", "mono-500", 21, PAPER.muted).node),
    h("div", { ...at(rx + 24, lowY - 18, 180, 36), alignItems: "center" }, label(measure, priceLabel(ruler.currencySymbol, ruler.low), "mono-700", 26, red).node),
  ];
}

function pill(value: NonNullable<SocialCardRecord["pill"]>): SocialCardElement {
  const style: Style = value.tone === "severity" ? { background: PEG_BAND_HEX.depeg, color: "#ffffff", border: `2px solid ${PEG_BAND_HEX.depeg}` }
    : value.tone === "positive" ? { background: PAPER.text, color: PAPER.ground, border: `2px solid ${PAPER.text}` }
      : { color: PAPER.text, border: `2px solid ${PAPER.text}` };
  return h("div", { ...font("mono-700"), fontSize: 24, lineHeight: 1.2, whiteSpace: "nowrap", flexShrink: 0, borderRadius: 8, padding: "5px 14px", ...style }, value.text);
}

/** Editorial and reference destinations on paper: one serif title, the date printed once. */
function record(spec: SocialCardRecord, assets: SocialCardAssets): SocialCardElement {
  const where = `Social card ${spec.path}`;
  const { measure } = assets;
  const width = (spec.ruler ? 860 : COLUMN.right) - COLUMN.left;
  // A headline measure: long titles stack into a block instead of one thin line.
  const measureWidth = Math.min(width, 840);
  const brand = lockup(assets, spec.label, "paper");
  // The subject rides in the dateline ("[logo] UST · 7–13 May 2022") when it fits there.
  const symbol = spec.identity ? label(measure, spec.identity.symbol, "mono-700", 24, PAPER.text) : null;
  const dateline = spec.dateline ? label(measure, symbol ? `· ${spec.dateline}` : spec.dateline, "mono-500", 24, PAPER.muted) : null;
  const room = COLUMN.right - COLUMN.left - brand.width - 40;
  const headIdentity = symbol !== null && 40 + 12 + symbol.width + (dateline ? 10 + dateline.width : 0) <= room;
  if (dateline && !headIdentity && label(measure, spec.dateline ?? "", "mono-500", 24, PAPER.muted).width > room) throw new SocialCardError(`${where} dateline: does not fit beside the lockup`);
  const pillWidth = spec.pill ? Math.ceil(measure.width(spec.pill.text, "mono-700", 24)) + 32 + 16 : 0;
  const facts = (spec.facts ?? []).map((value, index) => fitBlock(measure, where, { field: `facts[${index}]`, text: value, face: "mono-500", sizes: [26, 24, 22], lineHeight: 1.36, width: width - pillWidth, maxLines: 1 }));
  const factSize = Math.min(26, ...facts.map((fact) => fact.size));
  const factLine = Math.round(factSize * 1.36);
  const pillHeight = spec.pill ? Math.round(24 * 1.2) + 14 : 0;
  const footer = facts.length || spec.pill ? 30 + Math.max(pillHeight, facts.length * factLine) : 0;
  const head = spec.masthead ? 30 : 0;
  const identityRow = spec.identity && !headIdentity ? 64 + 18 : 0;
  const blocks: Block[] = [
    { field: "title", text: spec.title, face: "serif-500", sizes: steps(96, 52, 4), lineHeight: 1.02, tracking: -0.02, width: measureWidth, maxLines: 4 },
    ...(spec.dek ? [{ field: "dek", text: spec.dek, face: "serif-italic-400" as const, sizes: steps(38, 26), lineHeight: 1.22, width, maxLines: 3, gap: 22 }] : []),
  ];
  const [title, dek] = fitStack(measure, where, blocks, BODY.bottom - BODY.top - 14 - head - footer, identityRow);
  const topRight = headIdentity && spec.identity && symbol
    ? h("div", { alignItems: "center" },
      mark(assets, spec.identity, 40, `${where} identity`, { ring: PAPER.muted }),
      h("div", { marginLeft: 12 }, symbol.node),
      dateline ? h("div", { marginLeft: 10 }, dateline.node) : null)
    : spec.dateline ? label(measure, spec.dateline, "mono-500", 24, PAPER.muted).node : null;
  const factsNode = facts.length || spec.pill
    ? h("div", { alignItems: "flex-start", marginTop: 30 },
      spec.pill ? h("div", { marginRight: 16 }, pill(spec.pill)) : null,
      h("div", { flexDirection: "column", paddingTop: spec.pill ? Math.max(0, Math.round((pillHeight - factLine) / 2)) : 0 },
        ...facts.map((fact) => text({ ...fact, size: factSize, lineHeight: 1.36 }, PAPER.text, { whiteSpace: "nowrap" }))))
    : null;
  return canvas(PAPER.ground,
    h("div", { ...at(0, 0, 12, CARD_HEIGHT), background: RECORD_ACCENT[spec.accent] }),
    ...(spec.ruler ? recordRuler(assets, spec.ruler) : []),
    h("div", { ...at(COLUMN.left, 50, COLUMN.right - COLUMN.left, BODY.bottom - 50), flexDirection: "column" },
      h("div", { justifyContent: "space-between", alignItems: "center", height: 44 }, brand.node, topRight),
      spec.masthead ? h("div", { flexDirection: "column", marginTop: 22 }, h("div", { height: 3, background: PAPER.text }), h("div", { height: 1, marginTop: 4, background: PAPER.text })) : null,
      h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingTop: 30 },
        spec.identity && !headIdentity ? h("div", { alignItems: "center", marginBottom: 18, height: 64 },
          mark(assets, spec.identity, 56, `${where} identity`, { ring: PAPER.muted }),
          h("div", { marginLeft: 16 }, label(measure, spec.identity.symbol, "mono-700", 32, PAPER.text).node)) : null,
        text(title, PAPER.text),
        dek ? text(dek, PAPER.muted, { marginTop: dek.gap ?? 0 }) : null),
      factsNode));
}

export function buildSocialCardElement(input: SocialCardSpec, assets: SocialCardAssets): SocialCardElement {
  const spec = normalizeSocialCardSpec(input);
  switch (spec.template) {
    case "hub": return hub(spec, assets);
    case "dossier": return dossier(spec, assets);
    case "versus": return versus(spec, assets);
    case "record": return record(spec, assets);
  }
}


const isSafetyGrade = (grade: string): grade is SafetyGrade => (SAFETY_GRADE_VALUES as readonly string[]).includes(grade);
const gradeColor = (where: string, grade: string) => {
  if (!isSafetyGrade(grade)) throw new SocialCardError(`${where}: "${grade}" is not a published grade`);
  return GRADE_ON_DARK_HEX[gradeRange(grade)];
};

/** The one date on a scorecard: a frost outline, never a frost fill behind text (D5: "As of" only). */
function asOfPill(where: string, asOf: string): SocialCardElement {
  return h("div", { ...font("mono-700"), fontSize: 26, lineHeight: 1.2, color: FROST, border: `2px solid ${FROST}`, borderRadius: 8, padding: "5px 14px", whiteSpace: "nowrap" },
    `As of ${budget(where, "asOf", asOf, 16)}`);
}

/** The scorecard's hero inside the lens: the value, its score out of 100 and what it is. */
function scorecardLens(measure: SocialCardAssets["measure"], where: string, ring: string, value: { text: string; color: string; size: number }, figure: string | null, caption: string): SocialCardElement[] {
  const { cx, cy } = LENS;
  const hero = fitBlock(measure, where, { field: "lens", text: value.text, face: "display-800", sizes: steps(value.size, 72, 4), lineHeight: 1, tracking: -0.04, width: 224, maxLines: 1 });
  return [
    lens(cx, cy, LENS.r),
    plate(cx, cy, 140, { border: `4px solid ${ring}` }),
    h("div", { ...at(cx - 130, cy - 118, 260, 236), flexDirection: "column", alignItems: "center", justifyContent: "center" },
      text(hero, value.color, { textAlign: "center", justifyContent: "center", width: 260 }),
      h("div", { alignItems: "baseline", marginTop: 4 },
        figure === null ? null : label(measure, figure, "mono-700", 40, DARK.text).node,
        h("div", { marginLeft: figure === null ? 0 : 6 }, label(measure, "/100", "mono-500", 24, DARK.muted).node)),
      h("div", { marginTop: 2 }, label(measure, caption, "mono-500", 20, DARK.muted).node)),
  ];
}

/**
 * The dated scorecard: the only card that shows a grade, so the grade is the
 * hero in the lens, coloured by its family, and its date is the one outlined
 * pill. Sealed editions carry no pillar scores; without them the identity
 * stacks like a dossier's, with no empty pillar heading.
 */
export function buildSocialScorecardElement(card: SocialScorecardCard, assets: SocialCardAssets): SocialCardElement {
  const where = `Scorecard ${card.identity.symbol}`;
  const { measure } = assets;
  const subject = identity(where, "identity", card.identity);
  count(where, "pillars", card.pillars, 0, 4);
  const score = finite(where, "score", card.score);
  if (score < 0 || score > 100) throw new SocialCardError(`${where} score: ${score} is outside 0-100`);
  const color = gradeColor(`${where} grade`, card.grade);
  const hero = scorecardLens(measure, where, color, { text: card.grade, color, size: 132 }, String(Math.round(score)), "Safety Score");
  const pill = asOfPill(where, card.asOf);
  const pillHeight = Math.round(26 * 1.2) + 14;
  if (card.pillars.length === 0) {
    // A name that only repeats the ticker ("GHO", "Dai") is not printed twice.
    const repeated = subject.name.toLowerCase() === subject.symbol.toLowerCase();
    const identityLines = fitStack(measure, where, [
      { field: "identity.symbol", text: subject.symbol, face: "display-800", sizes: steps(112, 48, 4), lineHeight: 1, tracking: -0.035, width: COLUMN.width, maxLines: 1 },
      ...(repeated ? [] : [{ field: "identity.name", text: subject.name, face: "display-600" as const, sizes: steps(32, 24), lineHeight: 1.15, width: COLUMN.width, maxLines: 2, gap: 12 }]),
    ], BODY.bottom - BODY.top, 88 + 24 + 36 + pillHeight);
    return canvas(DARK.ground, ...hero,
      column(lockup(assets, "Dated scorecard", "dark").node, [
        h("div", { width: 88, height: 88, marginBottom: 24 }, mark(assets, subject, 88, `${where} identity`)),
        ...placed(identityLines, [DARK.text, DARK.muted]),
        h("div", { marginTop: 36 }, pill),
      ]));
  }
  const pillars = card.pillars.map((pillar, index) => ({
    name: budget(where, `pillars[${index}].name`, pillar.name, 20),
    score: finite(where, `pillars[${index}].score`, pillar.score),
    grade: pillar.grade,
    color: gradeColor(`${where} pillars[${index}].grade`, pillar.grade),
  }));
  // Identity: the logo beside the ticker, the full name under it.
  const textWidth = COLUMN.width - 72 - 18;
  const ticker = fitBlock(measure, where, { field: "identity.symbol", text: subject.symbol, face: "display-800", sizes: steps(66, 40, 2), lineHeight: 1, tracking: -0.03, width: textWidth, maxLines: 1 });
  const name = fitBlock(measure, where, { field: "identity.name", text: subject.name, face: "display-600", sizes: steps(28, 22), lineHeight: 1.15, width: textWidth, maxLines: 2 });
  const identityHeight = Math.max(72, ticker.height + 6 + name.height);
  // Pillar rows: the name column takes the longest name, the bar takes what is left.
  const nameSize = [26, 24, 22].find((size) => pillars.every((pillar) => measure.width(pillar.name, "display-600", size) <= 236)) ?? 22;
  const nameColumn = Math.ceil(Math.max(...pillars.map((pillar) => measure.width(pillar.name, "display-600", nameSize)))) + 18;
  const barWidth = COLUMN.width - nameColumn - 56 - 12 - 44;
  const rowHeight = 36;
  const pillarsHeight = 24 + 12 + pillars.length * rowHeight + (pillars.length - 1) * 12;
  const roomy = identityHeight + pillarsHeight + pillHeight + 40 + 36 <= BODY.bottom - BODY.top;
  if (!roomy && identityHeight + pillarsHeight + pillHeight + 24 + 24 > BODY.bottom - BODY.top) throw new SocialCardError(`${where}: the scorecard column overflows`);
  const row = (pillar: (typeof pillars)[number], index: number) => h("div", { alignItems: "center", height: rowHeight, marginTop: index > 0 ? 12 : 0 },
    h("div", { width: nameColumn }, label(measure, pillar.name, "display-600", nameSize, DARK.text).node),
    h("div", { width: barWidth, height: 10, borderRadius: 5, background: DARK.line },
      h("div", { width: Math.max(10, Math.round((barWidth * Math.min(100, Math.max(0, pillar.score))) / 100)), height: 10, borderRadius: 5, background: pillar.color })),
    h("div", { width: 56, justifyContent: "flex-end" }, label(measure, String(Math.round(pillar.score)), "mono-700", 26, DARK.text).node),
    h("div", { width: 44, marginLeft: 12 }, label(measure, pillar.grade, "mono-700", 26, pillar.color).node));
  return canvas(DARK.ground, ...hero,
    column(lockup(assets, "Dated scorecard", "dark").node, [
      h("div", { alignItems: "flex-start", height: identityHeight },
        h("div", { width: 72, height: 72, flexShrink: 0, marginTop: Math.round((ticker.height - 72) / 2) }, mark(assets, subject, 72, `${where} identity`)),
        h("div", { marginLeft: 18, flexDirection: "column" },
          text(ticker, DARK.text),
          text(name, DARK.muted, { marginTop: 6 }))),
      h("div", { flexDirection: "column", marginTop: roomy ? 40 : 24 },
        label(measure, "By pillar", "mono-500", 20, DARK.muted).node,
        h("div", { flexDirection: "column", marginTop: 12 }, ...pillars.map(row))),
      h("div", { marginTop: roomy ? 36 : 24 }, pill),
    ]));
}

/**
 * The dated Safety Scores overview: the accepted cohort's mean rated score in
 * the lens and its counts, never an aggregate letter grade, so the ring is a
 * neutral frost focus ring rather than a grade family.
 */
export function buildSocialScorecardOverviewElement(card: SocialScorecardOverviewCard, assets: SocialCardAssets): SocialCardElement {
  const where = "Scorecard overview";
  const { measure } = assets;
  const mean = finite(where, "meanScore", card.meanScore);
  if (mean < 0 || mean > 100) throw new SocialCardError(`${where} meanScore: ${mean} is outside 0-100`);
  const counts = ([[card.rated, "rated"], [card.notRated, "not rated"], [card.unavailable, "unavailable"]] as const).map(([value, noun]) => {
    if (!Number.isInteger(value) || value < 0) throw new SocialCardError(`${where} ${noun}: ${value} is not a count`);
    return { value, noun };
  });
  if (card.rated < 1) throw new SocialCardError(`${where}: a mean rated score needs at least one rated stablecoin`);
  // No-break spaces keep each count whole; a line that must wrap breaks after a separator.
  const tally = counts.filter(({ value }) => value > 0).map(({ value, noun }) => `${value.toLocaleString("en-US")} ${noun}`.replace(/ /g, "\u00a0")).join("\u00a0· ");
  const pill = asOfPill(where, card.asOf);
  const [headline, line] = fitStack(measure, where, [
    { field: "headline", text: "Safety Scores", face: "display-800", sizes: steps(104, 56, 4), lineHeight: 1, tracking: -0.035, width: COLUMN.width, maxLines: 2 },
    { field: "counts", text: tally, face: "mono-500", sizes: steps(26, 22), lineHeight: 1.3, width: COLUMN.width, maxLines: 2, gap: 24 },
  ], BODY.bottom - BODY.top, 36 + Math.round(26 * 1.2) + 14);
  return canvas(DARK.ground,
    ...scorecardLens(measure, where, FROST, { text: mean.toFixed(1), color: DARK.text, size: 120 }, null, "Mean rated score"),
    column(lockup(assets, "Dated scorecard", "dark").node, [
      ...placed([headline, line], [DARK.text, DARK.muted]),
      h("div", { marginTop: 36 }, pill),
    ]));
}
