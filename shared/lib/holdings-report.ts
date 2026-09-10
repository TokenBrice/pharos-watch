import { z } from "zod";

const Amount = z.string().regex(/^\d+\.\d{2}$/);
const Holding = z.object({
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/),
  name: z.string().min(1),
  category: z.enum(["treasury-bill", "bank-deposit", "cash"]),
  cusip: z.string().regex(/^[A-Z0-9]{9}$/).optional(),
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{10}$/).optional(),
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-shape decimal check; finite quantifiers, no backtracking ambiguity.
  quantity: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  marketValue: Amount,
}).strict();

export const HoldingsReportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("USDY"),
  scope: z.literal("Ondo USDY LLC only; excludes Ondo Global Markets (BVI) Limited issuance"),
  reportUrl: z.string().url(),
  listingUrl: z.string().url(),
  discoveryMode: z.literal("manual"),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reportByteLength: z.number().int().positive().max(4 * 1024 * 1024),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reportAsOf: z.string().datetime({ offset: true }),
  reportTimeZone: z.literal("America/New_York"),
  timeBasis: z.literal("Printed end-of-day date; 23:59:59 America/New_York assumed, not an upstream timestamp"),
  preparer: z.literal("Ondo USDY LLC"),
  reviewer: z.literal("Ankura Trust Company, LLC"),
  holdings: z.array(Holding).min(1).max(500),
  reportedAssetTotal: Amount,
  reportedLiabilityTotal: Amount,
}).strict().superRefine((manifest, ctx) => {
  const total = manifest.holdings.reduce((sum, row) => sum + BigInt(row.marketValue.replace(".", "")), 0n);
  if (total !== BigInt(manifest.reportedAssetTotal.replace(".", ""))) {
    ctx.addIssue({ code: "custom", message: "Holding market values do not reconcile to reported assets" });
  }
  if (new Set(manifest.holdings.map((row) => row.sourceId)).size !== manifest.holdings.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate holding source identity" });
  }
  const date = new Date(manifest.reportAsOf);
  const reportDay = new Intl.DateTimeFormat("en-CA", { timeZone: manifest.reportTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (reportDay !== manifest.reportDate || Number(manifest.reportedAssetTotal) <= 0) {
    ctx.addIssue({ code: "custom", message: "Invalid report date or non-positive asset total" });
  }
});

export type HoldingsReportManifest = z.infer<typeof HoldingsReportManifestSchema>;

/** Dropbox share URLs are reviewed pins; expiring download redirects stay on Dropbox. */
export function assertHoldingsReportHost(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "www.dropbox.com" || url.hostname === "dl.dropboxusercontent.com" || url.hostname.endsWith(".dl.dropboxusercontent.com"))) {
    throw new Error("usdy-holdings-report: unapproved report host");
  }
}

/** Opportunistic guard only: JS-only Dropbox listings still require daily manual review. */
export function assertNoNewerHoldingsReport(listing: string, reportDate: string): void {
  for (const match of listing.matchAll(/ATCAttest_(\d{2})(\d{2})(\d{2})\.pdf/g)) {
    const date = `20${match[1]}-${match[2]}-${match[3]}`;
    if (date > reportDate) throw new Error(`usdy-holdings-report: newer unreviewed report ${date}`);
  }
}
