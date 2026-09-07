#!/usr/bin/env node
/**
 * Generate one OG image per `/learn/case-studies/<slug>/` page.
 *
 * Cards are sourced from the typed case-study registry so slug, eyebrow
 * (kicker), title, outcome, and logo anchors never drift from the page.
 * Output: `public/og-learn-case-<slug>.png`, referenced by each page's
 * `generateMetadata`.
 *
 * Renders SVG → PNG via Playwright Firefox so the local Newsreader serif and
 * Geist Mono subsets render faithfully (matches build-og-editorial). Long
 * titles word-wrap; the editorial OG template only handled short titles.
 *
 *   tsx scripts/maintenance/build-og-case-studies.ts
 *   tsx scripts/maintenance/build-og-case-studies.ts --check
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CASE_STUDY_LIST } from "../../src/lib/case-studies";
import { escapeXml } from "../lib/og-svg.mts";
import { runOgStaticCli, runOgStaticMain } from "../lib/og-static-runner.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING_ROOT = resolve(REPO_ROOT, "agents/og-case-study-staging");
const STAGING = resolve(STAGING_ROOT, `run-${process.pid}`);
const SIGNATURE_PATH = resolve(REPO_ROOT, "scripts/maintenance/state/og-case-study-signatures.json");

// Coin logo lookup: tracked coins via data/logos.json (id -> "/logos/<file>"),
// cemetery-only coins (UST/IRON/FEI) via their cemetery logoUrl.
const LOGOS_BY_ID = JSON.parse(readFileSync(resolve(REPO_ROOT, "data/logos.json"), "utf-8"));
interface CemeteryLogoRow {
  id: string;
  logoUrl?: string | null;
}

const CEMETERY_ROWS = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "public/datasets/stablecoin-cemetery.json"), "utf-8"),
).rows as CemeteryLogoRow[];

function resolveLogoPath(primaryCoinId: string | undefined, cemeteryId: string | undefined): string | null {
  if (primaryCoinId && LOGOS_BY_ID[primaryCoinId]) {
    const p = resolve(REPO_ROOT, "public" + LOGOS_BY_ID[primaryCoinId]);
    if (existsSync(p)) return p;
  }
  if (cemeteryId) {
    const row = CEMETERY_ROWS.find((r) => r.id === cemeteryId);
    const m = row?.logoUrl?.match(/\/logos\/(.+)$/);
    if (m) {
      const p = resolve(REPO_ROOT, "public/logos/" + m[1]);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const OUTCOME_LABEL: Record<string, string> = { survived: "Survived", wounded: "Wounded", died: "Died" };
const OUTCOME_COLOR: Record<string, string> = { survived: "#15803d", wounded: "#a16207", died: "#dc2626" };

const CARDS = CASE_STUDY_LIST.map((study) => ({
  file: `og-learn-case-${study.slug}.png`,
  slug: study.slug,
  kicker: study.eyebrow,
  title: study.title,
  outcome: study.outcome,
  logoPath: resolveLogoPath(study.primaryCoinId, study.cemeteryId),
}));

function sha256(input: string | Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

function repoRelativePath(path: string) {
  return relative(REPO_ROOT, path).split("/").join("/");
}

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars` each. */
function wrapTitle(title: string, maxChars: number, maxLines: number) {
  const words = title.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function buildSvg({
  kicker,
  title,
  outcome,
  logoHref,
}: {
  kicker: string;
  title: string;
  outcome: string;
  logoHref: string | null;
}) {
  // Pick a font size that keeps the wrapped title to <= 3 lines.
  const tiers = [
    { maxChars: 26, size: 66, lh: 78 },
    { maxChars: 30, size: 56, lh: 68 },
    { maxChars: 36, size: 48, lh: 58 },
  ];
  let chosen = tiers[tiers.length - 1];
  let lines = wrapTitle(title, chosen.maxChars, 3);
  for (const tier of tiers) {
    const candidate = wrapTitle(title, tier.maxChars, 4);
    if (candidate.length <= 3) {
      chosen = tier;
      lines = candidate;
      break;
    }
  }
  const startY = 300;
  const titleTspans = lines
    .map(
      (line, i) =>
        `<tspan x="64" dy="${i === 0 ? 0 : chosen.lh}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const outcomeLabel = OUTCOME_LABEL[outcome] ?? null;
  const outcomeColor = OUTCOME_COLOR[outcome] ?? "#5f6570";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628">
  <defs><style>text { font-kerning: normal; }</style></defs>

  <defs><clipPath id="logoClip"><circle cx="1100" cy="40" r="22"/></clipPath></defs>

  <rect width="1200" height="628" fill="#f8f8fa"/>
  <rect width="1200" height="4" fill="#22c55e"/>
  <line x1="64" y1="64" x2="1136" y2="64" stroke="#d9dce1" stroke-width="1"/>

  <text x="64" y="50" font-family="'GeistMono', ui-monospace, monospace" font-size="22" font-weight="600" fill="#171719" letter-spacing="0">Pharos</text>
  ${
    logoHref
      ? `<text x="1052" y="46" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#5f6570" letter-spacing="0" text-anchor="end">Case Study</text>
  <circle cx="1100" cy="40" r="23" fill="#ffffff" stroke="#d9dce1" stroke-width="1"/>
  <image href="${escapeXml(logoHref)}" x="1078" y="18" width="44" height="44" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice"/>`
      : `<text x="1136" y="50" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#5f6570" letter-spacing="0" text-anchor="end">Case Study</text>`
  }

  <text x="64" y="200" font-family="'GeistMono', ui-monospace, monospace" font-size="20" font-weight="500" fill="#0e7490" letter-spacing="0">${escapeXml(
    (kicker ?? "Case Study").toUpperCase(),
  )}</text>
  <line x1="64" y1="224" x2="1136" y2="224" stroke="#e4e7eb" stroke-width="1"/>

  <text x="64" y="${startY}" font-family="'Newsreader', Georgia, serif" font-size="${chosen.size}" font-weight="500" fill="#171719" letter-spacing="0">${titleTspans}</text>

  <line x1="64" y1="540" x2="1136" y2="540" stroke="#d9dce1" stroke-width="1"/>
  ${
    outcomeLabel
      ? `<text x="64" y="580" font-family="'GeistMono', ui-monospace, monospace" font-size="18" font-weight="500" fill="${outcomeColor}" letter-spacing="0">${escapeXml(
          outcomeLabel.toUpperCase(),
        )}</text>`
      : ""
  }
  <text x="1136" y="580" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#5f6570" letter-spacing="0" text-anchor="end">pharos.watch</text>
</svg>
`;
}

const renderInputs = CARDS.map((card) => {
  const logo = card.logoPath
    ? {
        path: repoRelativePath(card.logoPath),
        sha256: sha256(readFileSync(card.logoPath)),
      }
    : null;
  return {
    file: card.file,
    svg: buildSvg({
      ...card,
      logoHref: card.logoPath ? pathToFileURL(card.logoPath).href : null,
    }),
    signatureSvg: buildSvg({
      ...card,
      logoHref: logo ? `repo://${logo.path}` : null,
    }),
    signature: {
      slug: card.slug,
      kicker: card.kicker,
      title: card.title,
      outcome: card.outcome,
      logo,
    },
  };
});

export async function main(): Promise<void> {
  await runOgStaticCli({
    repoRoot: REPO_ROOT,
    family: "Case-study",
    generatedBy: "scripts/maintenance/build-og-case-studies.ts",
    includePngHashes: false,
    publicDir: PUBLIC,
    refreshCommand: "npm run build:og-case-studies",
    roster: renderInputs,
    signaturePath: SIGNATURE_PATH,
    stagingDir: STAGING,
    settleMs: 400,
  });
}

runOgStaticMain(import.meta.url, main);
