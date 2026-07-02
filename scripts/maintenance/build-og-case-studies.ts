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
import { firefox } from "playwright";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CASE_STUDY_LIST } from "../../src/app/learn/case-studies/content";
import { escapeXml } from "../lib/og-svg.mjs";
import {
  assertNoStaleOgOutputs,
  formatOgWriteStatus,
  stalePngCheckLabel,
} from "../lib/og-image-checks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PUBLIC = resolve(REPO_ROOT, "public");
const STAGING_ROOT = resolve(REPO_ROOT, "agents/og-case-study-staging");
const STAGING = resolve(STAGING_ROOT, `run-${process.pid}`);
const SIGNATURE_PATH = resolve(REPO_ROOT, "scripts/maintenance/state/og-case-study-signatures.json");
const NEWSREADER_FONT = resolve(REPO_ROOT, "src/assets/fonts/Newsreader-Variable.subset.woff2");
const GEIST_MONO_FONT = resolve(REPO_ROOT, "src/assets/fonts/GeistMono-Regular.woff2");
const CHECK_MODE = process.argv.includes("--check");
const FONT_SIGNATURES = {
  newsreader: sha256(readFileSync(NEWSREADER_FONT)),
  geistMono: sha256(readFileSync(GEIST_MONO_FONT)),
};

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

mkdirSync(STAGING, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });
mkdirSync(dirname(SIGNATURE_PATH), { recursive: true });

const OUTCOME_LABEL: Record<string, string> = { survived: "Survived", wounded: "Wounded", died: "Died" };
const OUTCOME_COLOR: Record<string, string> = { survived: "#34d399", wounded: "#fbbf24", died: "#fb7185" };

const CARDS = CASE_STUDY_LIST.map((study) => ({
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

function buildSignatureManifest(
  cards: Array<{
    file: string;
    slug: string;
    kicker: string;
    title: string;
    outcome: string;
    logo: { path: string; sha256: string } | null;
    svgSha256: string;
  }>,
) {
  return `${JSON.stringify(
    {
      generatedBy: "scripts/maintenance/build-og-case-studies.ts",
      fonts: FONT_SIGNATURES,
      cards,
    },
    null,
    2,
  )}\n`;
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
  const outcomeColor = OUTCOME_COLOR[outcome] ?? "#8b8fa3";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628">
  <defs><style>text { font-kerning: normal; }</style></defs>

  <defs><clipPath id="logoClip"><circle cx="1100" cy="40" r="22"/></clipPath></defs>

  <rect width="1200" height="628" fill="#0a0f1e"/>
  <line x1="64" y1="64" x2="1136" y2="64" stroke="#E8DCC4" stroke-opacity="0.16" stroke-width="1"/>

  <text x="64" y="50" font-family="'GeistMono', ui-monospace, monospace" font-size="22" font-weight="600" fill="#E8DCC4" letter-spacing="0.16em">PHAROS</text>
  ${
    logoHref
      ? `<text x="1052" y="46" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#8b8fa3" letter-spacing="0.06em" text-anchor="end">Case Study</text>
  <circle cx="1100" cy="40" r="23" fill="#0a0f1e" stroke="#E8DCC4" stroke-opacity="0.18" stroke-width="1"/>
  <image href="${escapeXml(logoHref)}" x="1078" y="18" width="44" height="44" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice"/>`
      : `<text x="1136" y="50" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#8b8fa3" letter-spacing="0.06em" text-anchor="end">Case Study</text>`
  }

  <text x="64" y="200" font-family="'GeistMono', ui-monospace, monospace" font-size="20" font-weight="500" fill="#5ba3d9" letter-spacing="0.24em">${escapeXml(
    (kicker ?? "Case Study").toUpperCase(),
  )}</text>
  <line x1="64" y1="224" x2="1136" y2="224" stroke="#E8DCC4" stroke-opacity="0.10" stroke-width="1"/>

  <text x="64" y="${startY}" font-family="'Newsreader', Georgia, serif" font-size="${chosen.size}" font-weight="500" fill="#F5F0E6" letter-spacing="-0.015em">${titleTspans}</text>

  <line x1="64" y1="540" x2="1136" y2="540" stroke="#E8DCC4" stroke-opacity="0.16" stroke-width="1"/>
  ${
    outcomeLabel
      ? `<text x="64" y="580" font-family="'GeistMono', ui-monospace, monospace" font-size="18" font-weight="500" fill="${outcomeColor}" letter-spacing="0.12em">${escapeXml(
          outcomeLabel.toUpperCase(),
        )}</text>`
      : ""
  }
  <text x="1136" y="580" font-family="'GeistMono', ui-monospace, monospace" font-size="16" font-weight="400" fill="#8b8fa3" letter-spacing="0.04em" text-anchor="end">pharos.watch</text>
</svg>
`;
}

function buildHtml(svg: string) {
  const newsreaderUrl = pathToFileURL(NEWSREADER_FONT).href;
  const geistMonoUrl = pathToFileURL(GEIST_MONO_FONT).href;
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
  @font-face { font-family: 'Newsreader'; font-style: normal; font-weight: 200 800; src: url('${newsreaderUrl}') format('woff2'); font-display: block; }
  @font-face { font-family: 'GeistMono'; font-style: normal; font-weight: 400 700; src: url('${geistMonoUrl}') format('woff2'); font-display: block; }
  html, body { margin: 0; padding: 0; background: #0a0f1e; } svg { display: block; }
</style></head><body>${svg}</body></html>`;
}

async function main() {
  const browser = await firefox.launch({ headless: true });
  const staleFiles: string[] = [];
  const signatures: Array<{
    file: string;
    slug: string;
    kicker: string;
    title: string;
    outcome: string;
    logo: { path: string; sha256: string } | null;
    svgSha256: string;
  }> = [];
  try {
    for (const card of CARDS) {
      const fileName = `og-learn-case-${card.slug}.png`;
      const logoSignature = card.logoPath
        ? {
            path: repoRelativePath(card.logoPath),
            sha256: sha256(readFileSync(card.logoPath)),
          }
        : null;
      const signatureSvg = buildSvg({
        ...card,
        logoHref: logoSignature ? `repo://${logoSignature.path}` : null,
      });
      const svg = buildSvg({
        ...card,
        logoHref: card.logoPath ? pathToFileURL(card.logoPath).href : null,
      });
      signatures.push({
        file: fileName,
        slug: card.slug,
        kicker: card.kicker,
        title: card.title,
        outcome: card.outcome,
        logo: logoSignature,
        svgSha256: sha256(signatureSvg),
      });
      const svgPath = resolve(STAGING, `${card.slug}.svg`);
      const htmlPath = resolve(STAGING, `${card.slug}.html`);
      writeFileSync(svgPath, svg);
      writeFileSync(htmlPath, buildHtml(svg));

      const publicPath = resolve(PUBLIC, fileName);
      const outPath = CHECK_MODE ? resolve(STAGING, `${card.slug}.check.png`) : publicPath;
      const page = await browser.newPage({ viewport: { width: 1200, height: 628 } });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({
        path: outPath,
        omitBackground: false,
        clip: { x: 0, y: 0, width: 1200, height: 628 },
        timeout: 30000,
      });
      await page.close();

      if (CHECK_MODE) {
        const staleLabel = await stalePngCheckLabel({
          fileLabel: fileName,
          expectedPath: publicPath,
          actualPath: outPath,
        });
        if (staleLabel) {
          staleFiles.push(staleLabel);
        }
      }

      try {
        unlinkSync(svgPath);
        unlinkSync(htmlPath);
        if (CHECK_MODE) unlinkSync(outPath);
      } catch {
        /* swallow */
      }
      console.log(formatOgWriteStatus({ check: CHECK_MODE, publicPath }));
    }

    const signatureManifest = buildSignatureManifest(signatures);
    if (CHECK_MODE) {
      const expectedManifest = existsSync(SIGNATURE_PATH) ? readFileSync(SIGNATURE_PATH, "utf-8") : null;
      if (expectedManifest !== signatureManifest) {
        staleFiles.push("scripts/maintenance/state/og-case-study-signatures.json");
      }
    } else {
      writeFileSync(SIGNATURE_PATH, signatureManifest);
    }

    assertNoStaleOgOutputs({
      family: "Case-study",
      staleFiles,
      refreshCommand: "npm run build:og-case-studies",
    });
  } finally {
    await browser.close();
    rmSync(STAGING, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
