import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseCsv, recordFromCsvRow } from "../lib/gsc-report.mts";
import { HoldingsReportManifestSchema, assertHoldingsReportHost, type HoldingsReportManifest } from "../../shared/lib/holdings-report";

const money = (value: string) => value.replace(/,/g, "");
const scope = "Ondo USDY LLC only; excludes Ondo Global Markets (BVI) Limited issuance" as const;

/** Extract only the reviewed LLC daily layout; totals catch dropped/new material rows. */
export function parseUsdyDailyPdfText(text: string) {
  if (!text.includes("Daily Report Prepared by Ondo USDY LLC") || !text.includes("Ankura Trust Company, LLC") ||
      !text.includes("does not account for USDY issued by Ondo Global Markets (BVI) Limited")) {
    throw new Error("Not the reviewed USDY LLC daily report scope/layout");
  }
  const required = (pattern: RegExp, label: string) => {
    const match = text.match(pattern);
    if (!match) throw new Error(`USDY report missing ${label}`);
    return match;
  };
  const date = required(/Date \(end of day\)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/, "date");
  const reportDate = `${date[3]}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}`;
  const holdings: HoldingsReportManifest["holdings"] = [];
  for (const match of text.matchAll(/^(BNY Mellon|Marex) - US Treasuries\s+([\d,]+\.\d{2})\s+[\d.]+\s+([A-Z0-9]{9})\s/gm)) {
    holdings.push({ sourceId: `${match[1] === "Marex" ? "marex" : "stonex"}:${match[3].toLowerCase()}`, name: `${match[1]} US Treasury ${match[3]}`, category: "treasury-bill", cusip: match[3], marketValue: money(match[2]) });
  }
  for (const match of text.matchAll(/^ First Citizens - Ondo USDY (Operational Checking|Select MMA)\s+([\d,]+\.\d{2})\s/gm)) {
    if (Number(money(match[2])) > 0) holdings.push({ sourceId: `first-citizens:${match[1] === "Select MMA" ? "mma" : "checking"}`, name: `First Citizens ${match[1]}`, category: "bank-deposit", marketValue: money(match[2]) });
  }
  // Each non-bank account is bounded by its printed total. Blank cash is not invented.
  for (const account of ["StoneX", "Marex"]) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- account names are fixed literals from the loop above.
    const section = required(new RegExp(`\\n${account}\\s*\\n([\\s\\S]*?)Total - ${account}`), account)[1];
    const cash = section.match(/^ Cash\s+([\d,]+\.\d{2})\s+[\d.]+\s+[\d.]+%/m);
    if (cash && Number(money(cash[1])) > 0) holdings.push({ sourceId: `${account.toLowerCase()}:cash`, name: `${account} brokerage cash`, category: "cash", marketValue: money(cash[1]) });
  }
  return {
    reportDate, holdings,
    reportedAssetTotal: money(required(/Permitted Assets \(at market value\)\s+([\d,]+\.\d{2})/, "assets")[1]),
    reportedLiabilityTotal: money(required(/Token Principal Outstanding\s+([\d,]+\.\d{2})/, "principal")[1]),
  };
}

function endOfDayNewYork(date: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(noon).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "");
  if (!offset || !/^-0[45]:00$/.test(offset)) throw new Error("Cannot establish New York report offset");
  return `${date}T23:59:59${offset}`;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const input = option("--input");
  const reportUrl = option("--url");
  const listingUrl = option("--listing-url");
  if (!input || !reportUrl || !listingUrl) throw new Error("Usage: --input report.pdf|csv --url exact-download-url --listing-url month-folder-url [--output path]. CSV additionally requires --date YYYY-MM-DD --assets amount --liabilities amount; headers: sourceId,name,category,cusip,isin,quantity,marketValue.");
  assertHoldingsReportHost(reportUrl);
  assertHoldingsReportHost(listingUrl);
  const bytes = readFileSync(input);
  let extracted;
  if (extname(input).toLowerCase() === ".pdf") {
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Input is not PDF bytes");
    extracted = parseUsdyDailyPdfText(execFileSync("pdftotext", ["-layout", input, "-"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  } else if (extname(input).toLowerCase() === ".csv") {
    const [headers, ...csvRows] = parseCsv(bytes.toString("utf8"));
    if (!headers || new Set(headers).size !== headers.length || csvRows.some((row) => row.length !== headers.length)) throw new Error("Invalid CSV columns");
    const rows = csvRows.map((row) => recordFromCsvRow(headers, row));
    extracted = { reportDate: option("--date"), reportedAssetTotal: option("--assets"), reportedLiabilityTotal: option("--liabilities"), holdings: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== ""))) };
  } else throw new Error("Only downloaded PDF or CSV reports are supported");
  if (!extracted.reportDate) throw new Error("Report date required");
  const manifest = HoldingsReportManifestSchema.parse({
    schemaVersion: 1, product: "USDY", scope, reportUrl, listingUrl, discoveryMode: "manual",
    reportSha256: createHash("sha256").update(bytes).digest("hex"), reportByteLength: bytes.length,
    ...extracted, reportAsOf: endOfDayNewYork(extracted.reportDate), reportTimeZone: "America/New_York",
    timeBasis: "Printed end-of-day date; 23:59:59 America/New_York assumed, not an upstream timestamp",
    preparer: "Ondo USDY LLC", reviewer: "Ankura Trust Company, LLC",
  });
  const output = option("--output") ?? "shared/data/live-reserves/holdings-reports/usdy.json";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`USDY: ${manifest.holdings.length} holdings reconcile to $${manifest.reportedAssetTotal}; ${manifest.reportSha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
