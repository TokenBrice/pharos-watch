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

const MANIFEST_DIR = resolve("shared/data/live-reserves/independent-assurance");
const PRODUCTS = ["AUDX", "EUROP", "USDGO", "XSGD", "XUSD"] as const satisfies readonly IndependentAssuranceProduct[];
const AMOUNT = "([0-9][0-9,]*(?:\\.[0-9]+)?)";

interface CompilerProfile {
  product: IndependentAssuranceProduct;
  profile: string;
  officialIndexUrl: string;
  reportUrl: string;
  reportDate: string;
  reportAsOf: string;
  reportTimeZone: string;
  attestor: string;
  engagement: string;
  conclusion: IndependentAssuranceManifest["conclusion"];
  unit: IndependentAssuranceManifest["unit"];
  assetRows: Array<{ code: string; label: string; pattern: RegExp }>;
  liabilityRows: Array<{ code: string; label: string; pattern: RegExp }>;
  requiredText: Array<{ label: string; pattern: RegExp }>;
  rejectedText: Array<{ label: string; pattern: RegExp }>;
  reportedTotals: Array<{ label: string; expected: string; pattern: RegExp }>;
  reportedAssetTotal: string;
  computedAssetTotal: string;
  reportedLiabilityTotal: string;
  reportIssuedAt?: string;
}

function linePattern(label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- labels are fixed literals from the reviewed extraction tables below.
  return new RegExp(`^\\s*${label}\\d*\\s+\\$?${AMOUNT}\\s*$`, "im");
}

function usdgoScheduleAmountPattern(schedule: string, label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- schedule/label are fixed literals from the reviewed extraction tables below.
  return new RegExp(`${schedule}[\\s\\S]*?^\\s*${label}\\s+\\$?${AMOUNT}\\s*$`, "im");
}

function profile(product: IndependentAssuranceProduct): CompilerProfile {
  switch (product) {
    case "AUDX":
      return {
        product,
        profile: "audx-v1",
        officialIndexUrl: "https://www.audxtoken.com/transparency",
        reportUrl: "https://www.audxtoken.com/_files/ugd/539754_d2b6ce0bfdd947bda8375fe3283a0491.pdf",
        reportDate: "2026-07-31",
        reportAsOf: "2026-07-31T23:59:00+11:00",
        reportTimeZone: "AEDT (as printed in the report; normalized conservatively to UTC)",
        attestor: "Aura Partners",
        engagement: "Independent limited assurance engagement under ASAE 3000 and ASAE 3100",
        conclusion: "nothing-came-to-attention",
        unit: "AUD",
        assetRows: [
          {
            code: "designated-bank-accounts",
            label: "Australian Dollar reserves held in designated TAU accounts",
            pattern: linePattern("TOTAL Australian Dollar Reserves"),
          },
        ],
        liabilityRows: [
          { code: "polygon", label: "Polygon AUDX supply", pattern: linePattern("Polygon") },
          { code: "ethereum", label: "Ethereum AUDX supply", pattern: linePattern("Ethereum") },
          { code: "conflux", label: "Conflux AUDX supply", pattern: linePattern("Conflux") },
          { code: "redbelly", label: "Redbelly AUDX supply", pattern: linePattern("Redbelly") },
          { code: "xdc", label: "XDC AUDX supply", pattern: linePattern("XDC") },
          { code: "ink", label: "Ink AUDX supply", pattern: linePattern("Ink") },
          { code: "solana", label: "Solana AUDX supply", pattern: linePattern("Solana") },
        ],
        requiredText: [
          { label: "Aura Partners", pattern: /AURAPARTNERS|Aura Partners/i },
          { label: "ASAE 3000", pattern: /ASAE 3000/i },
          { label: "ASAE 3100", pattern: /ASAE 3100/i },
          { label: "AUDX report date", pattern: /31(?:st)? of July 2026/i },
          { label: "favorable AUDX conclusion", pattern: /nothing has come to our[\s\S]*attention/i },
        ],
        rejectedText: [
          { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
        ],
        reportedTotals: [
          { label: "AUDX supply total", expected: "3208057.00", pattern: linePattern("TOTAL AUDX Supply") },
          { label: "AUDX reserve total", expected: "3231371.79", pattern: linePattern("TOTAL Australian Dollar Reserves") },
        ],
        reportedAssetTotal: "3231371.79",
        computedAssetTotal: "3231371.79",
        reportedLiabilityTotal: "3208057.00",
      };
    case "EUROP":
      return {
        product,
        profile: "europ-v1",
        officialIndexUrl: "https://schuman.io/reserve-audits/",
        reportUrl: "https://schuman.io/wp-content/uploads/2026/07/SALVUS_Attestation_relative_au_nombre_de_jetons_EUROP_30_06_2026.pdf",
        reportDate: "2026-06-30",
        reportAsOf: "2026-06-30T08:00:00Z",
        reportTimeZone: "UTC",
        reportIssuedAt: "2026-07-03T10:06:52+02:00",
        attestor: "KPMG S.A.",
        engagement: "Statutory-auditor attestation under French CNCC professional doctrine; neither an audit nor a review",
        conclusion: "nothing-came-to-attention",
        unit: "EUR",
        assetRows: [
          { code: "cash", label: "Cash held at regulated financial institutions", pattern: linePattern("Cash Held at Regulated Financial Institutions") },
          { code: "cash-equivalents", label: "Cash equivalents held at regulated financial institutions", pattern: linePattern("Cash Equivalents Held at Regulated Financial Institutions") },
        ],
        liabilityRows: [
          { code: "ethereum", label: "Ethereum EURØP in circulation", pattern: linePattern("Ethereum") },
          { code: "polygon", label: "Polygon EURØP in circulation", pattern: linePattern("Polygon") },
          { code: "avalanche", label: "Avalanche EURØP in circulation", pattern: linePattern("Avalanche") },
          { code: "plasma", label: "Plasma EURØP in circulation", pattern: linePattern("Plasma") },
        ],
        requiredText: [
          { label: "KPMG S.A.", pattern: /KPMG S\.A\./i },
          { label: "statutory auditor", pattern: /statutory auditor/i },
          { label: "neither an audit nor a review", pattern: /neither an audit nor a review/i },
          { label: "EUROP report date", pattern: /June 30, 2026/i },
          { label: "favorable EUROP conclusion", pattern: /no matters to report/i },
        ],
        rejectedText: [
          { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
        ],
        reportedTotals: [
          { label: "EUROP circulation total", expected: "6840292.27", pattern: linePattern("EURØP in Circulation") },
          { label: "EUROP headline reserve total", expected: "7200276.54", pattern: linePattern("EURØP Cash and cash equivalent Reserve") },
        ],
        reportedAssetTotal: "7200276.54",
        computedAssetTotal: "7200276.13",
        reportedLiabilityTotal: "6840292.27",
      };
    case "USDGO":
      return {
        product,
        profile: "usdgo-v1",
        officialIndexUrl: "https://www.anchorage.com/platform/usdgo-reserve-attestations",
        reportUrl: "https://learn.anchorage.com/07.31.26_USDGO-Stablecoin-Attestation-Report-signed.pdf",
        reportDate: "2026-07-31",
        reportAsOf: "2026-07-31T23:59:59Z",
        reportTimeZone: "UTC",
        reportIssuedAt: "2026-08-28T23:59:00Z",
        attestor: "Deloitte & Touche LLP",
        engagement: "Independent accountant's examination under AICPA attestation standards",
        conclusion: "unmodified",
        unit: "USD",
        assetRows: [
          { code: "cash", label: "Cash", pattern: linePattern("Cash") },
          { code: "buidl", label: "BUIDL at fair value", pattern: linePattern("BUIDL, at fair value") },
          // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
          { code: "stbxx", label: "STBXX money market fund (CUSIP 38151N205)", pattern: /^\s*a\.\s+38151N205\s+N\/A\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
          // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
          { code: "jltxx", label: "JLTXX money market fund (CUSIP 46655R119)", pattern: /^\s*b\.\s+46655R119\s+N\/A\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
        ],
        liabilityRows: [
          {
            code: "solana",
            label: "Solana USDGO redeemable tokens",
            // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
            pattern: /^\s*a\.\s+Total USDGO natively minted tokens\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(?:[0-9][0-9,]*(?:\.[0-9]+)?|-)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im,
          },
        ],
        requiredText: [
          { label: "AICPA attestation standards", pattern: /American Institute of Certi(?:f|ﬁ)ied Public Accountants[\s\S]*AICPA/i },
          { label: "USDGO July 2026 report date", pattern: /July 31, 2026[\s\S]*11:59:59 PM Coordinated Universal Time/i },
          { label: "favorable examination conclusion", pattern: /fairly stated, in all material respects/i },
          { label: "USDGO Schedule I", pattern: /Schedule I: Total USDGO Natively Minted Tokens/i },
          { label: "USDGO Schedule II", pattern: /Schedule II: Composition of Reserve Assets/i },
          { label: "USDGO Schedule III", pattern: /Schedule III: Comparison Between the Reserve Assets/i },
        ],
        rejectedText: [
          { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
        ],
        reportedTotals: [
          // The reviewed dash is zero; omit the empty chain from positive liability rows.
          // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over the reviewed offline report.
          { label: "USDGO Morph liabilities", expected: "0", pattern: /^\s*a\.\s+Total USDGO natively minted tokens\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?|-)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im, },
          // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
          { label: "USDGO redeemable token total", expected: "1112640495", pattern: /^\s*Total USDGO redeemable tokens outstanding\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s+\(Schedule I\))?\s*$/im },
          { label: "USDGO reserve asset total", expected: "1116301304", pattern: usdgoScheduleAmountPattern("Schedule II:", "Total") },
        ],
        reportedAssetTotal: "1116301304",
        computedAssetTotal: "1116301304",
        reportedLiabilityTotal: "1112640495",
      };
    case "XSGD":
      return straitsxProfile(product, "SGD", "23,674,708", "23,661,169");
    case "XUSD":
      return straitsxProfile(product, "USD", "46,694,407", "46,615,142");
    default:
      throw new Error(`No offline compiler profile for ${product}`);
  }
}

function straitsxProfile(
  product: "XSGD" | "XUSD",
  unit: "SGD" | "USD",
  assetTotal: string,
  liabilityTotal: string,
): CompilerProfile {
  const xsgd = product === "XSGD";
  return {
    product,
    profile: "straitsx-v1",
    officialIndexUrl: `https://www.straitsx.com/${product.toLowerCase()}`,
    reportUrl: xsgd
      ? "https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/6a6c78f17a4f92b635508f81_XSGD%20SCS%20Reserve%20Account%20Report%20(30%20June%202026).pdf"
      : "https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/6a6c789f7ac035cdb7e226fc_XUSD%20SCS%20Reserve%20Account%20Report%20(30%20June%202026).pdf",
    reportDate: "2026-06-30",
    reportAsOf: "2026-06-30T23:59:00+08:00",
    reportTimeZone: "Singapore Time (GMT+8)",
    attestor: "KK Yap & Associates",
    engagement: "Independent accountant's reasonable-assurance examination under SSAE 3000 (Revised)",
    conclusion: "unqualified",
    unit,
    assetRows: xsgd
      ? [
          { code: "cash", label: "Cash", pattern: linePattern("Cash") },
          { code: "short-dated-government-or-repo", label: "Bonds or notes denominated in SGD with no more than three months residual maturity or eligible overnight reverse repos", pattern: /^\s*Bonds or notes denominated in SGD[^\n]*?\s+([0-9][0-9,]*)\s*$/im },
        ]
      : [
          { code: "cash", label: "Cash", pattern: linePattern("Cash") },
          { code: "fixed-deposits", label: "Fixed Deposits", pattern: linePattern("Fixed Deposits") },
          { code: "short-dated-government-or-repo", label: "U.S. Treasury or eligible overnight reverse-repo instruments", pattern: /^\s*Bonds or notes denominated in USD[^\n]*?\s+([0-9][0-9,]*)\s*$/im },
        ],
    liabilityRows: xsgd
      ? [
          { code: "erc20", label: "XSGD ERC20 circulation", pattern: linePattern("XSGD \\(ERC20\\)") },
          { code: "zrc2", label: "XSGD ZRC2 circulation", pattern: linePattern("XSGD \\(ZRC2\\)") },
          { code: "pos", label: "XSGD POS circulation", pattern: linePattern("XSGD \\(POS\\)") },
          { code: "hts", label: "XSGD HTS circulation", pattern: linePattern("XSGD \\(HTS\\)") },
          { code: "avax", label: "XSGD AVAX circulation", pattern: linePattern("XSGD \\(AVAX\\)") },
          { code: "arb", label: "XSGD ARB circulation", pattern: linePattern("XSGD \\(ARB\\)") },
          { code: "xrp", label: "XSGD XRP circulation", pattern: linePattern("XSGD \\(XRP\\)") },
          { code: "lat", label: "XSGD LAT circulation", pattern: linePattern("XSGD \\(LAT\\)") },
          { code: "base", label: "XSGD BASE circulation", pattern: linePattern("XSGD \\(BASE\\)") },
          { code: "sol", label: "XSGD SOL circulation", pattern: linePattern("XSGD \\(SOL\\)") },
        ]
      : [
          { code: "erc20", label: "XUSD ERC20 circulation", pattern: linePattern("XUSD \\(ERC20\\)") },
          { code: "bep20", label: "XUSD BEP20 circulation", pattern: linePattern("XUSD \\(BEP20\\)") },
          { code: "pol", label: "XUSD POL circulation", pattern: linePattern("XUSD \\(POL\\)") },
          { code: "sol", label: "XUSD SOL circulation", pattern: linePattern("XUSD \\(SOL\\)") },
        ],
    requiredText: [
      { label: "KK Yap & Associates", pattern: /KK YAP & ASSOCIATES/i },
      { label: "SSAE 3000", pattern: /SSAE\)?\s*3000/i },
      { label: "reasonable assurance", pattern: /reasonable assurance/i },
      { label: `${product} report date`, pattern: /30 June 2026/i },
      { label: "favorable StraitsX conclusion", pattern: /in our opinion[\s\S]*fairly stated/i },
    ],
    rejectedText: [
      { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
    ],
    reportedTotals: [
      { label: `${product} circulation total`, expected: liabilityTotal.replace(/,/g, ""), pattern: linePattern(`A\\. Total par value1 of ${product} in circulation`) },
      { label: `${product} reserve total`, expected: assetTotal.replace(/,/g, ""), pattern: linePattern("B\\. Marked-to-market value of Reserve Assets held in a trust account") },
    ],
    reportedAssetTotal: assetTotal.replace(/,/g, ""),
    computedAssetTotal: assetTotal.replace(/,/g, ""),
    reportedLiabilityTotal: liabilityTotal.replace(/,/g, ""),
  };
}

function amountFromMatch(match: RegExpMatchArray | null, label: string): string {
  const raw = match?.[1];
  if (!raw) throw new Error(`offline assurance compiler: could not extract ${label}`);
  return raw === "-" ? "0" : raw.replace(/[$,]/g, "");
}

function assertProfileText(text: string, config: CompilerProfile): void {
  for (const check of config.requiredText) {
    if (!check.pattern.test(text)) throw new Error(`offline assurance compiler: missing ${check.label}`);
  }
  for (const check of config.rejectedText) {
    if (check.pattern.test(text)) throw new Error(`offline assurance compiler: rejected ${check.label}`);
  }
  for (const total of config.reportedTotals) {
    const actual = amountFromMatch(text.match(total.pattern), total.label);
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
    amount: amountFromMatch(text.match(row.pattern), row.label),
  }));
  const liabilities = config.liabilityRows.map((row) => ({
    code: row.code,
    label: row.label,
    amount: amountFromMatch(text.match(row.pattern), row.label),
  }));
  const manifest: IndependentAssuranceManifest = {
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
    engagement: config.engagement,
    conclusion: config.conclusion,
    unit: config.unit,
    assets,
    liabilities,
    reportedAssetTotal: config.reportedAssetTotal,
    computedAssetTotal: config.computedAssetTotal,
    reportedLiabilityTotal: config.reportedLiabilityTotal,
    extraction: {
      tool: "Poppler pdftotext -layout",
      parserVersion,
      normalizedTextSha256: textSha256,
      pageCount,
    },
  };
  IndependentAssuranceManifestSchema.parse(manifest);
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

const product = requireProduct();
const pdfPath = parseFlag("--pdf");
if (!pdfPath) throw new Error("Use --pdf /path/to/official-report.pdf");
const compiled = compile(resolve(pdfPath), profile(product));
const outputPath = parseFlag("--out") ?? resolve(MANIFEST_DIR, `${product.toLowerCase()}.json`);
const checkOnly = process.argv.includes("--check");

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
