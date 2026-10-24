import { z } from "zod";
import { MECHANISM_ARCHETYPE_VALUES } from "./core";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Expected valid ISO day");
const timestamp = text.refine((value) => Number.isFinite(Date.parse(value)), "Expected parseable date");
/** Plain text, or an ordered mix of plain text and styled inline spans. */
const richText = z.union([
  text,
  z.array(z.union([z.string(), z.object({ code: text }).strict(), z.object({ emphasis: text }).strict(), z.object({ numeric: text }).strict()])),
]);
/** Ordered published card body; weights renders the six-dimension weight row. */
const detail = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraph"), text: richText }).strict(),
  z.object({ kind: z.literal("list"), items: z.array(richText) }).strict(),
  z.object({ kind: z.literal("formula"), text }).strict(),
  z.object({ kind: z.literal("weights"), values: z.tuple([text, text, text, text, text, text]) }).strict(),
  z.object({
    kind: z.literal("table"), ariaLabel: text, tableId: text, testId: text,
    columns: z.array(z.object({ id: text, label: text, rowHeader: z.boolean().optional(), headClassName: z.string().optional(), cellClassName: z.string().optional() }).strict()),
    rows: z.array(z.object({ id: text, cells: z.record(z.string(), z.string()) }).strict()),
  }).strict(),
  z.strictObject({ kind: z.literal("section"), heading: text, get blocks() { return z.array(detail); } }),
]);
export const MethodologyContentSchema = z.array(z.object({
  version: text, title: text, date,
  /** Unix seconds; shared activations resolve to the highest numeric version. Use one-second offsets only for meaningful within-batch order. */
  effectiveAt: z.number().int().nonnegative(),
  summary: text,
  impact: z.array(text),
  /** Ordered rich body; absent detail renders summary plus impact. */
  detail: z.array(detail).optional(),
  /** Real hashes, best-effort independently of reconstructed; empty provenance is valid for contemporaneous entries too. */
  commits: z.array(text.regex(/^[0-9a-f]{7,40}$/)),
  /** false = contemporaneous; true = reconstructed from git history, not a claim about commit evidence. */
  reconstructed: z.boolean(),
}).strict()).min(1);
/** Internal absolute path such as /methodology/; external and protocol-relative URLs are invalid. */
const internalHref = z.custom<`/${string}`>((value) => typeof value === "string" && /^\/(?!\/)/.test(value), "Expected internal absolute path");
export const WeeklyContentSchema = z.object({
  /** ISO YYYY-MM-DD dates are required for lexicographic barrel sorting and year grouping. */
  dateRange: z.object({ from: date, to: date }).strict(),
  /** One-sentence thesis summarising the release's biggest moves. */
  headline: text.optional(),
  /** Recurring Courier-italic Field Notes column, at most 80 words, above the structural summary. */
  fieldNotes: text.refine((value) => value.trim().split(/\s+/).length <= 80, "Field notes exceed 80 words").optional(),
  summary: z.array(z.object({ label: text, description: text, tag: z.enum(["feature", "security", "coverage", "infra", "design"]), href: internalHref.optional() }).strict()).min(1),
  /** Authoritative noise-filtered count; may exceed the rendered commit list. */
  stats: z.object({ totalCommits: z.number().int().positive() }).strict(),
  /** At most 20 rendered commits; the remainder stays in totalCommits and git history. */
  commits: z.array(z.object({ hash: text.regex(/^[0-9a-f]{7,40}$/), message: text }).strict()).min(1).max(20),
}).strict().superRefine((entry, ctx) => {
  if (entry.dateRange.from > entry.dateRange.to) ctx.addIssue({ code: "custom", path: ["dateRange"], message: "Date range is reversed" });
  const fromMs = Date.parse(`${entry.dateRange.from}T00:00:00Z`);
  const toMs = Date.parse(`${entry.dateRange.to}T00:00:00Z`);
  if (new Date(fromMs).getUTCDay() !== 1 || toMs - fromMs !== 6 * 86_400_000) ctx.addIssue({ code: "custom", path: ["dateRange"], message: "Weekly changelog range must span exactly Monday through Sunday" });
  if (entry.stats.totalCommits < entry.commits.length) ctx.addIssue({ code: "custom", path: ["stats", "totalCommits"], message: "Total commits is less than the rendered list" });
});
const eventWindow = z.object({
  startISO: timestamp, endISO: timestamp.optional(), peakDeviationBps: z.number().min(-10_000).max(10_000).optional(),
  lowPrice: z.number().positive().max(2).optional(),
  /** Plain-language boundary for venue- or market-specific figures. */
  metricScope: text.optional(),
  /** Annotation membership; defaults to every related coin. */
  relatedCoinIds: z.array(text).optional(),
}).strict().refine((window) => !window.endISO || Date.parse(window.endISO) >= Date.parse(window.startISO), "Event window is reversed");
/** Long-form retrospectives link down into depeg records, cemetery obituaries and chart annotations rather than restating them. */
export const CaseStudyContentSchema = z.object({
  /** URL slug and content filename: /learn/case-studies/<slug>/. */
  slug: text,
  /** Short category kicker, e.g. Algorithmic collapse. */
  eyebrow: text,
  title: text,
  /** One-sentence standfirst and line-clamped hub-card summary. */
  subtitle: text,
  lead: z.array(text).min(1),
  /** Optional 3–4-bullet Key takeaways block above the chart. */
  takeaways: z.array(text).optional(),
  /** Tracked coin filename identity enables stablecoin links/charts; cemetery-only studies use cemeteryId instead. At least one is required. */
  primaryCoinId: text.optional(),
  relatedCoins: z.array(z.object({
    /** Must match a shared/data/stablecoins/coins/<id>.json filename. */
    coinId: text, note: text,
  }).strict()).optional(),
  archetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
  /** survived = recovered to peg; wounded = live but structurally scarred; died = decommissioned. */
  outcome: z.enum(["survived", "wounded", "died"]),
  /** Human label for cards/meta, e.g. March 2023. */
  eventDateLabel: text,
  /** Headline window and boundary for displayed metrics. */
  eventWindow,
  /** Disjoint incident windows for charts and annotation linking. */
  eventWindows: z.array(eventWindow).min(1).optional(),
  /** Cross-links into existing layers, validated at build time. */
  depegEventSlug: text.regex(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-(up|down))?$/).optional(), cemeteryId: text.optional(),
  timeline: z.array(z.object({
    /** ISO date (day precision is fine), driving chronological order. */
    dateISO: timestamp, headline: text,
    /** 1–3 sentences; numbers must match the recorded event. */
    body: text,
    /** Same high/med/low vocabulary as the chart-annotation tape. */
    severity: z.enum(["high", "med", "low"]).optional(), href: text.optional(),
  }).strict()).min(1),
  sections: z.array(z.object({
    /** Unique kebab-case, immutable after publication: editorial-selector identity, not display text. */
    id: text.regex(/^[a-z0-9-]+$/).refine((id) => !id.startsWith("-") && !id.endsWith("-") && !id.includes("--"), "Invalid section id"), heading: text, paragraphs: z.array(text).min(1),
  }).strict()).min(1),
  /** Live client-side useSupplyHistory chart under static export, without annotation overlays; only for data-rich (roughly 2024+) coins with a real series. Omit pre-collection events. */
  dataWidgets: z.array(z.object({ kind: z.literal("peg-deviation"), coinId: text, caption: text }).strict()).optional(),
  watchpoints: z.array(text).min(1), crossLinks: z.array(z.object({ href: internalHref, label: text }).strict()),
  sources: z.array(z.object({ label: text,
    /** Primary source: issuer post-mortem, regulator filing, rekt.news, etc. */
    href: text,
  }).strict()).min(1),
  /** Optional search-phrased `<title>` (before the " | Pharos" suffix); the editorial `title` stays the H1. */
  metaTitle: text.max(52).optional(),
  /** At most 160 characters for the meta description. */
  metaDescription: text.max(160),
  /** ISO datePublished anchor for Article JSON-LD. */
  datePublished: date,
}).strict().superRefine((study, ctx) => {
  if (!study.primaryCoinId && !study.cemeteryId) ctx.addIssue({ code: "custom", message: "Study needs a tracked coin or cemetery identity" });
  if (new Set(study.sections.map((section) => section.id)).size !== study.sections.length) ctx.addIssue({ code: "custom", path: ["sections"], message: "Duplicate section ids" });
  for (let index = 1; index < study.timeline.length; index++) {
    if (Date.parse(study.timeline[index].dateISO) < Date.parse(study.timeline[index - 1].dateISO)) ctx.addIssue({ code: "custom", path: ["timeline", index], message: "Timeline is not chronological" });
  }
});

const link = z.object({ href: internalHref, label: text }).strict();
export const DependencyMapContentSchema = z.object({
  description: text, metadataTitle: text, title: text, lead: text, headerSupplement: text,
  lens: z.object({ kicker: text, graph: text, start: text, scores: link, between: text, coverage: link, end: text, scope: text }).strict(),
  faq: z.array(z.object({ question: text, answer: text }).strict()).min(1),
  exposure: z.object({
    description: text, roots: text, empty: text, add: text, choose: text, trace: text, share: text,
    reset: text, remove: text, history: text, historyDescription: text, historyLink: link,
  }).strict(),
}).strict();
export const DependencyExposureContentSchema = z.object({ id: text, title: text, markdownParagraphs: z.array(text).min(1) }).strict();

/** Type-only readonly views accept authored literals without freezing or transforming parsed JSON. */
type ReadonlyEditorial<T> = T extends object ? { readonly [K in keyof T]: ReadonlyEditorial<T[K]> } : T;
type MethodologyEntry = z.output<typeof MethodologyContentSchema>[number];
export type MethodologyChangelogEntry = { [K in keyof MethodologyEntry]: ReadonlyEditorial<MethodologyEntry[K]> };
export type MethodologyChangelogRichText = ReadonlyEditorial<z.output<typeof richText>>;
export type MethodologyChangelogInline = Exclude<MethodologyChangelogRichText, string>[number];
export type MethodologyChangelogDetailBlock = ReadonlyEditorial<z.output<typeof detail>>;
export type MethodologyChangelogDetailTableColumn = Extract<MethodologyChangelogDetailBlock, { kind: "table" }>["columns"][number];
export type MethodologyChangelogDetailTableRow = Extract<MethodologyChangelogDetailBlock, { kind: "table" }>["rows"][number];
export type ChangelogEntry = z.output<typeof WeeklyContentSchema>;
export type CommitRef = ChangelogEntry["commits"][number];
export type SummaryItem = ChangelogEntry["summary"][number];
export type SummaryTag = SummaryItem["tag"];
export type SummaryHref = z.output<typeof internalHref>;
export type CaseStudy = ReadonlyEditorial<z.output<typeof CaseStudyContentSchema>>;
export type CaseStudyOutcome = CaseStudy["outcome"];
export type CaseStudyTimelineEntry = CaseStudy["timeline"][number];
export type CaseStudySeverity = NonNullable<CaseStudyTimelineEntry["severity"]>;
export type CaseStudySection = CaseStudy["sections"][number];
export type CaseStudyDataWidget = NonNullable<CaseStudy["dataWidgets"]>[number];
export type CaseStudyCrossLink = CaseStudy["crossLinks"][number];
export type CaseStudyRelatedCoin = NonNullable<CaseStudy["relatedCoins"]>[number];
export type CaseStudyEventWindow = CaseStudy["eventWindow"];
export type CaseStudySource = CaseStudy["sources"][number];
