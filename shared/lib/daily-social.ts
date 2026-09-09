import { z } from "zod";
import { StrictIsoDateSchema } from "../types/safety-schema-primitives";
import { DAILY_SOCIAL_TOPICS } from "./daily-social-schedule";

export const DailySocialTopicSchema = z.enum(DAILY_SOCIAL_TOPICS);
export type DailySocialTopic = z.infer<typeof DailySocialTopicSchema>;
const text = (max: number) => z.string().min(1).max(max).refine((value) => !/[\r\n\u0000-\u001f]/.test(value));
export const DailySocialSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  editionDate: StrictIsoDateSchema,
  scheduledAt: z.number().int().positive(),
  capturedAt: z.number().int().positive(),
  asOf: z.number().int().positive(),
  topic: DailySocialTopicSchema,
  fallbackFor: DailySocialTopicSchema.optional(),
  title: text(70),
  subtitle: text(140),
  unit: z.enum(["usd", "percent", "percentage-points", "bps", "score", "count"]),
  rows: z.array(z.object({ id: text(100), name: text(150), symbol: text(20).optional(), value: z.number().finite(), context: text(160) }).strict()).min(1).max(5),
  highlights: z.array(z.object({ label: text(45), value: text(70) }).strict()).max(4),
  source: text(150),
  methodology: text(420),
}).strict().superRefine((snapshot, ctx) => {
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(snapshot.scheduledAt * 1000));
  if (localDate !== snapshot.editionDate || snapshot.asOf > snapshot.capturedAt + 60
    || new Set(snapshot.rows.map((row) => row.id)).size !== snapshot.rows.length) {
    ctx.addIssue({ code: "custom", message: "Invalid edition date, source timestamp, or duplicate rows" });
  }
  if (snapshot.rows.some((row) => snapshot.unit === "count" ? !Number.isInteger(row.value) || row.value < 0
    : snapshot.unit === "score" ? row.value < 0 || row.value > 100 : false)) {
    ctx.addIssue({ code: "custom", message: "Counts must be nonnegative integers and scores must be between 0 and 100" });
  }
});
export type DailySocialSnapshot = z.infer<typeof DailySocialSnapshotSchema>;

export function formatDailySocialValue(value: number, unit: DailySocialSnapshot["unit"]): string {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (unit === "usd") {
    const [scale, suffix] = magnitude >= 1e12 ? [1e12, "T"] : magnitude >= 1e9 ? [1e9, "B"] : magnitude >= 1e6 ? [1e6, "M"] : magnitude >= 1e3 ? [1e3, "K"] : [1, ""];
    return `${sign}$${(magnitude / scale).toFixed(2)}${suffix}`;
  }
  const number = value.toLocaleString("en-US", { maximumFractionDigits: unit === "percentage-points" ? 3 : 2 });
  return `${number}${unit === "percent" ? "%" : unit === "percentage-points" ? " pp" : unit === "bps" ? " bps" : unit === "score" ? "/100" : ""}`;
}

export function buildDailySocialTweetText(snapshot: DailySocialSnapshot): string {
  const rows = snapshot.rows.map((row, index) => `${index + 1}. ${(row.symbol ?? row.name).slice(0, 20)} ${formatDailySocialValue(row.value, snapshot.unit)}`);
  const footer = "\n\npharos.watch #Stablecoins";
  // Conservative X budget: non-ASCII code points count twice and the fixed
  // 12-character domain expands to the 23-character t.co URL weight.
  const length = (value: string) => Array.from(value).reduce((sum, char) => sum + (char.codePointAt(0)! > 127 ? 2 : 1), 11);
  // Keep complete facts; omit whole lower-ranked rows if unusually long labels exceed X's limit.
  while (rows.length > 0 && length(`${snapshot.title}\n\n${rows.join("\n")}${footer}`) > 270) rows.pop();
  return `${snapshot.title}\n\n${rows.join("\n")}${footer}`;
}

export function buildDailySocialAltText(snapshot: DailySocialSnapshot): string {
  const heading = `${snapshot.title}. ${snapshot.subtitle}. Data as of ${new Date(snapshot.asOf * 1000).toISOString()}.`;
  const suffix = ` ${snapshot.methodology} Source: ${snapshot.source}.`;
  const rows = snapshot.rows.map((row) => `${(row.symbol ?? row.name).slice(0, 30)}: ${formatDailySocialValue(row.value, snapshot.unit)}.`).join(" ");
  const fullRows = snapshot.rows.map((row) => `${(row.symbol ?? row.name).slice(0, 30)}: ${formatDailySocialValue(row.value, snapshot.unit)}; ${row.context}.`).join(" ");
  return `${heading} ${`${heading} ${fullRows}${suffix}`.length <= 1000 ? fullRows : rows}${suffix}`.slice(0, 1000);
}
