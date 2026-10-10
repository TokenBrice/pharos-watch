import { z } from "zod";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MethodologyChangelogDetailBlock, MethodologyChangelogEntry, MethodologyChangelogRichText } from "@shared/lib/methodology-versions/base";
import type { CaseStudy } from "../../src/lib/case-studies/types";
import type { ChangelogEntry, SummaryHref } from "../../src/data/changelogs/types";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Expected valid ISO day");
const timestamp = text.refine((value) => Number.isFinite(Date.parse(value)), "Expected parseable date");
const richText: z.ZodType<MethodologyChangelogRichText> = z.union([
  text,
  z.array(z.union([z.string(), z.object({ code: text }).strict(), z.object({ emphasis: text }).strict(), z.object({ numeric: text }).strict()])),
]);
const detail: z.ZodType<MethodologyChangelogDetailBlock> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraph"), text: richText }).strict(),
  z.object({ kind: z.literal("list"), items: z.array(richText) }).strict(),
  z.object({ kind: z.literal("formula"), text }).strict(),
  z.object({ kind: z.literal("weights"), values: z.tuple([text, text, text, text, text, text]) }).strict(),
  z.object({
    kind: z.literal("table"), ariaLabel: text, tableId: text, testId: text,
    columns: z.array(z.object({ id: text, label: text, rowHeader: z.boolean().optional(), headClassName: z.string().optional(), cellClassName: z.string().optional() }).strict()),
    rows: z.array(z.object({ id: text, cells: z.record(z.string(), z.string()) }).strict()),
  }).strict(),
  z.object({ kind: z.literal("section"), heading: text, blocks: z.array(detail) }).strict(),
]));
export const MethodologyContentSchema: z.ZodType<MethodologyChangelogEntry[]> = z.array(z.object({
  version: text, title: text, date, effectiveAt: z.number().int().nonnegative(), summary: text,
  impact: z.array(text), detail: z.array(detail).optional(), commits: z.array(text.regex(/^[0-9a-f]{7,40}$/)), reconstructed: z.boolean(),
}).strict()).min(1);
const internalHref: z.ZodType<SummaryHref> = z.custom<SummaryHref>((value) => typeof value === "string" && /^\/(?!\/)/.test(value), "Expected internal absolute path");
export const WeeklyContentSchema: z.ZodType<ChangelogEntry> = z.object({
  dateRange: z.object({ from: date, to: date }).strict(), headline: text.optional(),
  fieldNotes: text.refine((value) => value.trim().split(/\s+/).length <= 80, "Field notes exceed 80 words").optional(),
  summary: z.array(z.object({ label: text, description: text, tag: z.enum(["feature", "security", "coverage", "infra", "design"]), href: internalHref.optional() }).strict()).min(1),
  stats: z.object({ totalCommits: z.number().int().positive() }).strict(),
  commits: z.array(z.object({ hash: text.regex(/^[0-9a-f]{7,40}$/), message: text }).strict()).min(1).max(20),
}).strict().superRefine((entry, ctx) => {
  if (entry.dateRange.from > entry.dateRange.to) ctx.addIssue({ code: "custom", path: ["dateRange"], message: "Date range is reversed" });
  if (entry.stats.totalCommits < entry.commits.length) ctx.addIssue({ code: "custom", path: ["stats", "totalCommits"], message: "Total commits is less than the rendered list" });
});
const eventWindow = z.object({
  startISO: timestamp, endISO: timestamp.optional(), peakDeviationBps: z.number().min(-10_000).max(10_000).optional(),
  lowPrice: z.number().positive().max(2).optional(), metricScope: text.optional(), relatedCoinIds: z.array(text).optional(),
}).strict().refine((window) => !window.endISO || Date.parse(window.endISO) >= Date.parse(window.startISO), "Event window is reversed");
export const CaseStudyContentSchema: z.ZodType<CaseStudy> = z.object({
  slug: text, eyebrow: text, title: text, subtitle: text, lead: z.array(text).min(1), takeaways: z.array(text).optional(),
  primaryCoinId: text.optional(), relatedCoins: z.array(z.object({ coinId: text, note: text }).strict()).optional(),
  archetype: z.enum(MECHANISM_ARCHETYPE_VALUES), outcome: z.enum(["survived", "wounded", "died"]), eventDateLabel: text,
  eventWindow, eventWindows: z.array(eventWindow).min(1).optional(), depegEventSlug: text.regex(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-(up|down))?$/).optional(), cemeteryId: text.optional(),
  timeline: z.array(z.object({ dateISO: timestamp, headline: text, body: text, severity: z.enum(["high", "med", "low"]).optional(), href: text.optional() }).strict()).min(1),
  sections: z.array(z.object({ id: text.regex(/^[a-z0-9-]+$/).refine((id) => !id.startsWith("-") && !id.endsWith("-") && !id.includes("--"), "Invalid section id"), heading: text, paragraphs: z.array(text).min(1) }).strict()).min(1),
  dataWidgets: z.array(z.object({ kind: z.literal("peg-deviation"), coinId: text, caption: text }).strict()).optional(),
  watchpoints: z.array(text).min(1), crossLinks: z.array(z.object({ href: internalHref, label: text }).strict()),
  sources: z.array(z.object({ label: text, href: text }).strict()).min(1), metaDescription: text.max(160), datePublished: date,
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

export interface EditorialReferences {
  routes: ReadonlySet<string>;
  coinIds: ReadonlySet<string>;
  cemeteryIds: ReadonlySet<string>;
}

/** Validate explicit link/identity fields without transforming any authored prose. */
export function editorialReferenceIssues(input: unknown, references: EditorialReferences): string[] {
  const issues: string[] = [];
  function visit(value: unknown, path: string): void {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\]\((\/[^)\s]+)\)/g)) visit({ href: match[1] }, path);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const field = `${path}.${key}`;
      if (key === "href" && typeof child === "string") {
        if (child.startsWith("/") && !child.startsWith("//")) {
          const url = new URL(child, "https://pharos.watch");
          const route = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
          if (!references.routes.has(route)) issues.push(`${field}: Unknown internal route ${child}`);
        } else if (!/^https?:\/\//.test(child)) issues.push(`${field}: Invalid link ${child}`);
      } else if ((key === "coinId" || key === "primaryCoinId") && typeof child === "string") {
        if (!references.coinIds.has(child)) issues.push(`${field}: Unknown coin id ${child}`);
      } else if (key === "relatedCoinIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id !== "string" || !references.coinIds.has(id)) issues.push(`${field}: Unknown coin id ${String(id)}`);
      } else if (key === "cemeteryId" && typeof child === "string") {
        if (!references.cemeteryIds.has(child)) issues.push(`${field}: Unknown cemetery id ${child}`);
      } else visit(child, field);
    }
  }
  visit(input, "content");
  return issues;
}
