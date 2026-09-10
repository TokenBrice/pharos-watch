import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getIndependentAssuranceManifest,
  IndependentAssuranceManifestSchema,
  reconcileIndependentAssuranceManifest,
  type IndependentAssuranceManifest,
  type IndependentAssuranceProduct,
} from "@shared/lib/independent-assurance";
import { MANIFEST_SOURCES } from "../../shared/data/live-reserves/independent-assurance";
import { COMPILER_PROFILES } from "../lib/independent-assurance-profiles";
import type { CompilerProfile } from "../lib/independent-assurance-profiles/shared";

const MANIFEST_DIR = resolve("shared/data/live-reserves/independent-assurance");
const PRODUCTS = Object.keys(COMPILER_PROFILES) as IndependentAssuranceProduct[];

function amountFromMatch(
  match: RegExpMatchArray | null,
  label: string,
  normalizeAmount?: (raw: string) => string,
): string {
  const raw = match?.[1];
  if (!raw) throw new Error(`offline assurance compiler: could not extract ${label}`);
  return normalizeAmount ? normalizeAmount(raw) : raw === "-" ? "0" : raw.replace(/[$,]/g, "");
}

function assertProfileText(text: string, config: CompilerProfile): void {
  for (const check of config.requiredText) {
    if (!check.pattern.test(text)) throw new Error(`offline assurance compiler: missing ${check.label}`);
  }
  for (const check of config.rejectedText) {
    if (check.pattern.test(text)) throw new Error(`offline assurance compiler: rejected ${check.label}`);
  }
  for (const total of config.reportedTotals) {
    const actual = amountFromMatch(text.match(total.pattern), total.label, config.normalizeAmount);
    if (actual !== total.expected) {
      throw new Error(`offline assurance compiler: ${total.label} ${actual} does not match reviewed ${total.expected}`);
    }
  }
}

function extractText(pdfPath: string): { text: string; parserVersion: string; pageCount: number } {
  const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
  const version = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  const versionOutput = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  const parserVersion = versionOutput.match(/version\s+([^\s]+)/i)?.[1];
  if (!parserVersion) throw new Error("offline assurance compiler: could not determine pdftotext version");
  const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw new Error("offline assurance compiler: invalid PDF page count");
  return { text, parserVersion, pageCount };
}

function compile(pdfPath: string, config: CompilerProfile): IndependentAssuranceManifest {
  const bytes = readFileSync(pdfPath);
  const { text, parserVersion, pageCount } = extractText(pdfPath);
  assertProfileText(text, config);
  const textSha256 = createHash("sha256").update(text).digest("hex");
  const reportSha256 = createHash("sha256").update(bytes).digest("hex");
  const assets = config.assetRows.map((row) => ({
    code: row.code,
    label: row.label,
    amount: amountFromMatch(text.match(row.pattern), row.label, config.normalizeAmount),
  }));
  const liabilities = config.liabilityRows.map((row) => ({
    code: row.code,
    label: row.label,
    amount: amountFromMatch(text.match(row.pattern), row.label, config.normalizeAmount),
  }));
  const adjustments = (config.adjustments ?? []).map((row) => ({
    code: row.code,
    label: row.label,
    amount: amountFromMatch(text.match(row.pattern), row.label, config.normalizeAmount),
    treatment: row.treatment,
  }));
  const manifest = IndependentAssuranceManifestSchema.parse({
    schemaVersion: 1,
    product: config.product,
    profile: config.profile,
    officialIndexUrl: config.officialIndexUrl,
    reportUrl: config.reportUrl,
    reportSha256,
    reportByteLength: bytes.length,
    reportDate: config.reportDate,
    reportAsOf: config.reportAsOf,
    reportTimeZone: config.reportTimeZone,
    ...(config.reportIssuedAt ? { reportIssuedAt: config.reportIssuedAt } : {}),
    attestor: config.attestor,
    ...(config.attestorIdentification ? { attestorIdentification: config.attestorIdentification } : {}),
    engagement: config.engagement,
    conclusion: config.conclusion,
    unit: config.unit,
    assets,
    liabilities,
    ...(adjustments.length > 0 ? { adjustments } : {}),
    reportedAssetTotal: config.reportedAssetTotal,
    computedAssetTotal: config.computedAssetTotal,
    reportedLiabilityTotal: config.reportedLiabilityTotal,
    extraction: {
      tool: "Poppler pdftotext -layout",
      parserVersion,
      normalizedTextSha256: textSha256,
      pageCount,
    },
  });
  reconcileIndependentAssuranceManifest(manifest, config.product === "EUROP"
    ? {
        reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
        reportedLiabilityTotalTolerance: { absolute: "1", relativePpm: 1 },
      }
    : undefined);
  return manifest;
}

function parseFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireProduct(): IndependentAssuranceProduct {
  const value = parseFlag("--product");
  if (!value || !(PRODUCTS as readonly string[]).includes(value)) {
    throw new Error(`Use --product ${PRODUCTS.join("|")}`);
  }
  return value as IndependentAssuranceProduct;
}

const checkOnly = process.argv.includes("--check");
const pdfPath = parseFlag("--pdf");
if (checkOnly && !parseFlag("--product") && !pdfPath) {
  for (const product of Object.keys(MANIFEST_SOURCES) as IndependentAssuranceProduct[]) {
    if (!COMPILER_PROFILES[product]) throw new Error(`No offline compiler profile for ${product}`);
  }
  for (const product of PRODUCTS) {
    const config = COMPILER_PROFILES[product]!;
    const manifest = getIndependentAssuranceManifest(product);
    for (const field of ["product", "profile", "officialIndexUrl", "reportUrl", "reportDate", "reportAsOf",
      "reportTimeZone", "reportIssuedAt", "attestor", "engagement", "conclusion", "unit",
      "reportedAssetTotal", "computedAssetTotal", "reportedLiabilityTotal"] as const) {
      if (config[field] !== manifest[field]) throw new Error(`Offline profile ${product}.${field} differs from reviewed manifest`);
    }
    if (JSON.stringify(config.attestorIdentification ?? null) !== JSON.stringify(manifest.attestorIdentification ?? null)) {
      throw new Error(`Offline profile ${product}.attestorIdentification differs from reviewed manifest`);
    }
    for (const [rows, amounts] of [[config.assetRows, manifest.assets], [config.liabilityRows, manifest.liabilities]] as const) {
      if (rows.length !== amounts.length || rows.some((row, index) => row.code !== amounts[index].code || row.label !== amounts[index].label)) {
        throw new Error(`Offline profile ${product} row definitions differ from reviewed manifest`);
      }
    }
    const profileAdjustments = config.adjustments ?? [];
    const manifestAdjustments = manifest.adjustments ?? [];
    if (profileAdjustments.length !== manifestAdjustments.length ||
      profileAdjustments.some((row, index) => row.code !== manifestAdjustments[index]?.code ||
        row.label !== manifestAdjustments[index]?.label ||
        row.treatment !== manifestAdjustments[index]?.treatment)) {
      throw new Error(`Offline profile ${product} adjustment definitions differ from reviewed manifest`);
    }
    reconcileIndependentAssuranceManifest(manifest, product === "EUROP"
      ? {
          reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
          reportedLiabilityTotalTolerance: { absolute: "1", relativePpm: 1 },
        }
      : undefined);
    console.log(`Validated ${product}: registered manifest, compiler profile, and reconciliation (no PDF re-extraction)`);
  }
} else {
  const product = requireProduct();
  if (!pdfPath) throw new Error("Use --pdf /path/to/official-report.pdf");
  const compiled = compile(resolve(pdfPath), COMPILER_PROFILES[product]!);
  const outputPath = parseFlag("--out") ?? resolve(MANIFEST_DIR, `${product.toLowerCase()}.json`);
  if (checkOnly) {
    const reviewed = getIndependentAssuranceManifest(product);
    if (JSON.stringify(compiled) !== JSON.stringify(reviewed)) {
      throw new Error(`Offline compilation differs from reviewed ${outputPath}; stop for review before writing`);
    }
    console.log(`Verified ${product}: ${compiled.reportSha256.slice(0, 12)}… ${compiled.reportByteLength} bytes`);
  } else if (process.argv.includes("--write")) {
    writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`);
    console.log(`Wrote ${outputPath}`);
  } else {
    console.log(JSON.stringify(compiled, null, 2));
    console.error("Candidate only. Pass --write explicitly after review.");
  }
}
