# SEO Week 3-4: Markdown Content Negotiation + Public `/docs/*` Routes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "AI-agent accessibility" release. Two features: (A) RFC 7231 content negotiation so AI agents that send `Accept: text/markdown` receive a pre-rendered `.md` variant of high-value routes with `Vary: Accept` for cache correctness; (B) expose the repo's 40+ canonical docs in `docs/` as first-class public pages under `/docs/*`, rendered with Pharos chrome and proper JSON-LD.

**Architecture:** A single build-time markdown generator (`scripts/generate-markdown-exports.ts`) runs as part of `prebuild` and writes colocated `<route>/index.md` files into the static export at the same paths as HTML `index.html`. A new Cloudflare Pages Function (`functions/_middleware.ts`) inspects GET requests, serves the colocated `.md` variant when `Accept: text/markdown` is present, and attaches `Vary: Accept` to every response. For Feature B, a dynamic `/docs/[slug]/` route uses `generateStaticParams` + `next-mdx-remote/rsc` to render selected `docs/*.md` files with the existing `FeaturePageShell` and emits `TechArticle` + `BreadcrumbList` JSON-LD; a curated allowlist lives in `shared/lib/public-docs.ts` so the same list drives `generateStaticParams`, the sitemap, `llms.txt`, and the docs index page.

**Tech Stack:** Next.js 16 static export, Cloudflare Pages Functions, TypeScript, `tsx` for build scripts, `next-mdx-remote` (RSC variant), `remark-gfm`, `vitest`.

**Prerequisites (Weeks 1-2 must be shipped):**

- **Week 1** must have landed `BreadcrumbJsonLd` N-level support. Current `src/components/breadcrumb-json-ld.tsx` only emits a 2-item list (Home → {name}). Feature B needs `Home → Docs → {doc}`, i.e. the 3-item form. If Week 1 did not extend `BreadcrumbJsonLd`, Task B.6 cannot proceed without reopening that scope. **Blocker check at start of Feature B.**
- **Week 2** must have shipped `public/llms.txt`. Task B.9 appends a `## Docs` section to it. If `public/llms.txt` does not exist, fall through to creating it inline — but that was the Week 2 deliverable and should already be there.

**Out of Scope (future plans, do NOT touch here):**

- Per-coin JSON AI endpoints (`/data/<coin>.json`) — deferred to a later plan.
- Wikidata entity alignment / Schema.org `sameAs` linking — future plan.
- CI pipeline changes beyond `merge-gate` integration of the new generator script.
- Translating docs to other languages / i18n.
- Extending markdown negotiation beyond the four route classes listed in Feature A (home page, taxonomy pages, chain pages, compare pages are explicitly out of scope for this release).
- Dynamic `/api/og/*` response negotiation (image endpoint, not applicable).
- Rewriting methodology TSX pages into MDX source files. Feature A renders them to markdown via an adapter; parallel authoring is considered and rejected below.
- Markdown variants of `/admin/*`, `/funding/*`, `/status/*` — these are either host-gated, `noindex`, or operator-only.

---

## Architecture Decisions (locked in — read before implementing)

Every decision below was made explicitly rather than left open. Deviation requires re-planning.

**1. Where does the build-time markdown generator live?**
`scripts/generate-markdown-exports.ts`. It sits next to `generate-redirects.ts` and `generate-sitemap-dates.ts` and is wired into the existing `prebuild` npm script. Rationale: the two existing generators already set the pattern; nothing here justifies a new directory.

**2. Where do `.md` variants land in the static export?**
Colocated at `out/<route-path>/index.md`, mirroring the HTML structure (`out/<route-path>/index.html`). Rationale: this lets the Pages Function serve the variant by rewriting the URL to `/<path>/index.md` with zero path translation, and it makes Cloudflare's asset handler discover the file without extra routing rules. The alternative — a parallel `out/_markdown/...` tree — would require path remapping in the middleware and was rejected.

**3. Does the Pages Function middleware interact with existing Pages Functions?**
Yes. Existing functions are path-specific: `functions/admin/[[path]].ts`, `functions/_site-data/[[path]].ts`, `functions/api/admin/...`. A new top-level `functions/_middleware.ts` runs on **every** request (Cloudflare's `_middleware.ts` convention). It must call `next(request)` to chain through to the asset handler / sibling functions except when it is directly serving a `.md` variant. The middleware must NOT touch `/admin/*`, `/_site-data/*`, `/api/*` — it short-circuits for those prefixes. Reference: `functions/admin/[[path]].ts` and `functions/_site-data/[[path]].ts`.

**4. MDX library choice for `/docs/*` rendering.**
`next-mdx-remote@^5` with the RSC server export (`next-mdx-remote/rsc`). Rationale: the codebase has **no** existing MDX dep; this package is the smallest addition that works with Next 16 React Server Components and produces static output under `output: "export"`. `@mdx-js/react` is rejected because it requires webpack loader config that conflicts with `next.config.ts` simplicity. `remark-gfm` is added for GitHub-flavored markdown (tables in the docs).

**5. How to get `dateModified` for docs.**
Use `git log -1 --format=%aI -- <path>` at build time, executed inside `scripts/generate-markdown-exports.ts` and threaded into `src/generated/docs-metadata.json`. Mirrors the exact pattern in `scripts/generate-sitemap-dates.ts:12-14`. Front-matter parsing is rejected — would require authors to keep it updated.

**6. Methodology pages: parallel `.md` authoring vs. render-to-markdown?**
**Render-to-markdown** from the TSX source via a small adapter. The methodology pages (`src/app/methodology/sections/core/*.tsx` and `src/app/methodology/sections/monitoring/*.tsx`) import static text, version constants, and factual content. The adapter in `scripts/lib/methodology-to-markdown.ts` imports each section's `MethodologyTextContent` export (new Task A.3 adds these exports) and stringifies to markdown. Parallel authoring was considered and rejected: 11 methodology routes × ongoing edits = perpetual drift, and the existing `content-*.tsx` files already split out narrative content from presentation, which makes extraction tractable. Snapshot tests (Task A.11) guard against silent drift.

**7. Which docs are public?**
A curated allowlist in `shared/lib/public-docs.ts`. Non-public docs are not force-excluded — they are simply not listed. The initial list is **24 docs** (see Task B.1). Agent-authored working notes (`agents/**`, `docs/agent-*.md`, `docs/doc-ownership.json`, `docs/documentation-map-*.tsv`) stay repo-internal.

**8. Will `Vary: Accept` fragment the CDN cache?**
Yes, by design. Cloudflare honors `Vary: Accept` per their docs (confirmed against `https://developers.cloudflare.com/cache/concepts/cache-control/#vary`). Two cache entries per URL (one for `text/html`, one for `text/markdown`) is the expected, acceptable cost. The hit rate loss is negligible because agent traffic is ~5% of total.

**9. What Accept header values count as markdown?**
`text/markdown` (with optional quality param) OR `text/x-markdown`. Parsed by a small helper that handles `q=` weighting but does NOT negotiate against HTML as a richer format — we only serve markdown when the client prefers it (`q` for markdown ≥ `q` for HTML, and `text/markdown` is actually present). `*/*` alone does NOT trigger markdown. Implemented in Task A.6.

**10. How do we detect "the HTML variant is noindex" so we don't serve a markdown variant for a noindex route?**
Hardcoded allowlist of route **class prefixes** at the top of `functions/_middleware.ts`. Only requests whose path begins with `/methodology/`, `/stablecoin/`, `/changelog`, `/digest/`, or `/docs/` are considered. This is both the simplest check and also matches exactly the routes the generator writes `.md` files for. We do not parse HTML for a `<meta name="robots">` tag.

---

## File Structure (locked in before task breakdown)

### New files
- `scripts/generate-markdown-exports.ts` — build-time generator, runs in `prebuild`.
- `scripts/lib/methodology-to-markdown.ts` — adapter that stringifies methodology section content.
- `scripts/lib/markdown-renderers.ts` — per-route-class renderers (stablecoin, digest, changelog, methodology, docs).
- `scripts/__tests__/generate-markdown-exports.test.ts` — unit tests + snapshot fixtures for the generator.
- `scripts/__tests__/fixtures/markdown/` — snapshot fixtures for generated markdown.
- `functions/_middleware.ts` — top-level Pages middleware for `Accept: text/markdown` negotiation and `Vary: Accept`.
- `functions/__tests__/middleware.test.ts` — unit test for middleware behavior.
- `src/app/docs/page.tsx` — docs index listing all public docs grouped by section.
- `src/app/docs/[slug]/page.tsx` — dynamic doc route rendering a single markdown file.
- `shared/lib/public-docs.ts` — curated allowlist + grouping metadata (runtime-neutral so sitemap + generator + index page share one source).
- `shared/lib/__tests__/public-docs.test.ts` — asserts every listed doc exists on disk and the slug matches.
- `src/generated/docs-metadata.json` — per-doc `dateModified`, written by the generator.

### Modified files
- `package.json` — extend `prebuild`; add `next-mdx-remote`, `remark-gfm` deps.
- `next.config.ts` — no change unless we hit static export issues with `next-mdx-remote` (contingency only; see Task B.5).
- `src/app/sitemap.ts` — add docs routes via `PUBLIC_DOCS` import.
- `src/app/methodology/sections/core/*.tsx` + `src/app/methodology/sections/monitoring/*.tsx` — extract `CONTENT_MARKDOWN` constants (one per section) so the adapter can import them without rendering JSX.
- `public/llms.txt` — append `## Docs` section.
- `src/app/about/api/page.tsx` — add paragraph pointing to `/docs/api-reference/` and documenting the `Accept: text/markdown` protocol.
- `src/app/about/page.tsx` — add one link to `/docs/`.
- `docs/architecture.md` — add a section documenting both features.
- `docs/README.md` — add a pointer that these docs are now served at `/docs/`.
- `public/_headers` — no change (middleware sets `Vary: Accept` dynamically, which is correct; static headers don't apply to dynamic responses).
- `scripts/lib/deploy-impact.mjs` — add `scripts/generate-markdown-exports.ts`, `scripts/lib/methodology-to-markdown.ts`, `scripts/lib/markdown-renderers.ts`, `functions/_middleware.ts`, `src/app/docs/**`, `shared/lib/public-docs.ts` to the pages-deploy trigger globs (verify the file first — it may already cover `scripts/**` and `functions/**`).
- `scripts/check-seo-static.mjs` — no modification, but the `check:doc-source-paths` and `check:verified-doc-links` scripts will need to be consulted to ensure the docs routes don't trip them.

---

## Phasing Recommendation

Feature A first, Feature B second, each as its own PR. Rationale:

- **Feature A is independent**: the generator + middleware ship even if no docs go public. Most of its value — markdown for stablecoin/methodology/changelog/digest — can land alone and immediately start capturing AI traffic.
- **Feature B depends on Feature A** only for the **negotiation middleware** (so `/docs/architecture` also serves markdown on `Accept: text/markdown`). The MDX rendering and routing don't need Feature A.
- Staging reduces the blast radius of a potential middleware regression. If A deploys badly, B never gets blocked by it.
- Target: A ships in the first week (easy path), B ships in the second week.

**Commit strategy:** **Two PRs**, one per feature. Inside each PR, commit after every task (TDD loop: failing test → minimal implementation → passing test → commit). Do not amend.

---

# FEATURE A: Markdown Content Negotiation

Ships first. Target: days 1-5.

## Task A.1: Dependency and scaffolding

**Goal:** Install deps, create empty generator script, wire into `prebuild`.

**Files:**
- Modify: `package.json` — add `remark-gfm` (dev), extend `prebuild` script.
- Create: `scripts/generate-markdown-exports.ts` (empty skeleton).
- Create: `scripts/lib/markdown-renderers.ts` (empty skeleton).

- [ ] **Step 1: Install deps**

```bash
npm install --save-dev remark-gfm@^4
```

Expected: `remark-gfm` appears in `package.json` devDependencies. Note: `next-mdx-remote` is a Feature B dep and is not installed here.

- [ ] **Step 2: Create the generator skeleton**

Create `scripts/generate-markdown-exports.ts`:

```ts
/* eslint-disable security/detect-non-literal-fs-filename -- repo-local build script reads checked-in files under the repository root only. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../out");

async function main() {
  // Task A.4, A.5, A.7, A.8 will fill this in.
  console.log("generate-markdown-exports: no routes wired yet");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Create the renderers skeleton**

Create `scripts/lib/markdown-renderers.ts`:

```ts
import type { ChangelogEntry } from "../../src/data/changelogs/types";

export interface MarkdownRoute {
  /** Route path beginning and ending with slash, e.g. `/stablecoin/usdt-tether/`. */
  path: string;
  /** Fully rendered markdown body including YAML front-matter. */
  body: string;
}

export function renderChangelogIndex(entries: readonly ChangelogEntry[]): string {
  // Task A.7 implements this.
  void entries;
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Wire into `prebuild`**

Modify `package.json` line 16:

Before:
```json
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts",
```

After:
```json
"prebuild": "tsx scripts/generate-redirects.ts && tsx scripts/generate-sitemap-dates.ts && tsx scripts/generate-markdown-exports.ts",
```

- [ ] **Step 5: Run `npm run build` to confirm nothing breaks**

```bash
npm run build
```

Expected: successful build, `generate-markdown-exports: no routes wired yet` appears in output. Exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/generate-markdown-exports.ts scripts/lib/markdown-renderers.ts
git commit -m "scaffold(md): add prebuild markdown generator stub"
```

## Task A.2: Generator infrastructure — write route to colocated `.md`

**Goal:** Add a helper that writes a `MarkdownRoute` to `out/<path>/index.md`, creating directories as needed. Matches the static export convention.

**Files:**
- Modify: `scripts/generate-markdown-exports.ts`.
- Create: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/generate-markdown-exports.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMarkdownRoute } from "../generate-markdown-exports";

describe("writeMarkdownRoute", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pharos-md-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes markdown at <outDir><path>/index.md", () => {
    writeMarkdownRoute(tmpDir, {
      path: "/stablecoin/usdt-tether/",
      body: "# USDT\n\nBody content.\n",
    });

    const expected = join(tmpDir, "stablecoin", "usdt-tether", "index.md");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toBe("# USDT\n\nBody content.\n");
  });

  it("rejects paths not ending with slash", () => {
    expect(() =>
      writeMarkdownRoute(tmpDir, { path: "/docs/architecture", body: "x" }),
    ).toThrow(/trailing slash/i);
  });

  it("rejects paths containing .. segments", () => {
    expect(() =>
      writeMarkdownRoute(tmpDir, { path: "/docs/../etc/", body: "x" }),
    ).toThrow(/path traversal/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: FAIL — `writeMarkdownRoute is not a function`.

- [ ] **Step 3: Implement `writeMarkdownRoute`**

Add to `scripts/generate-markdown-exports.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface MarkdownRoute {
  path: string;
  body: string;
}

export function writeMarkdownRoute(outDir: string, route: MarkdownRoute): void {
  if (!route.path.startsWith("/") || !route.path.endsWith("/")) {
    throw new Error(`Path must start and end with a trailing slash: ${route.path}`);
  }
  if (route.path.includes("..")) {
    throw new Error(`Path traversal segments are not allowed: ${route.path}`);
  }
  const segments = route.path.split("/").filter((s) => s.length > 0);
  const target = resolve(outDir, ...segments, "index.md");
  const resolvedOutDir = resolve(outDir);
  if (!target.startsWith(resolvedOutDir + sep) && target !== resolvedOutDir) {
    throw new Error(`Resolved path escapes outDir: ${target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, route.body);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-markdown-exports.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): add writeMarkdownRoute with traversal guards"
```

## Task A.3: Extract methodology section text content to stringifiable constants

**Goal:** Each of the 11 methodology sections (6 core + 5 monitoring) needs a `CONTENT_MARKDOWN` constant export so the adapter can stringify without rendering React. This is surgical — we do not rewrite the sections, just add a sibling export.

**Files:**
- Modify: `src/app/methodology/sections/core/safety-scores-section.tsx`, `liquidity-section.tsx`, `stability-index-section.tsx`, `infrastructure-section.tsx`, `mint-burn-flow-section.tsx`, `liquidity-technical-details.tsx`.
- Modify: `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`, `chain-health-section.tsx`, `blacklist-tracker-section.tsx`, `contagion-stress-test-section.tsx`, `yield-intelligence-section.tsx`.

- [ ] **Step 1: Read every section file and identify the narrative text**

```bash
ls src/app/methodology/sections/core/ src/app/methodology/sections/monitoring/
```

Open each file and locate the `<p>...</p>` narrative paragraphs inside `MethodologySectionShell`. The content to extract is the human-readable prose — not the component structure or examples.

- [ ] **Step 2: For each section file, add a `CONTENT_MARKDOWN` export**

For example, in `src/app/methodology/sections/core/safety-scores-section.tsx`, add at the top (after imports, before the component):

```ts
export const CONTENT_MARKDOWN = `## Safety Scores Grading Methodology

Pharos synthesizes multiple data signals into a single transparent grade per stablecoin. The overall score is computed in two steps: first, a weighted average of four base dimensions (exit liquidity, resilience, decentralization, dependency risk), then a peg stability multiplier that penalizes coins with poor pegs while barely affecting well-pegged ones. The exit-liquidity dimension blends raw DEX liquidity with redemption-backstop adjustments when a usable route exists.

(...continue with all narrative prose from this section, Markdown-escaped, preserving paragraph breaks as blank lines...)
`;
```

Do **not** remove the inline JSX — keep the rendered page identical. The constant is in addition to the JSX. The authoritative source is the rendered text; if the JSX changes, you must update the constant in the same commit (Task A.11 snapshot tests enforce this).

Repeat for each of the 11 section files. Use the section's existing `id` / `title` props as the heading.

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Run existing methodology tests**

```bash
npm test -- src/app/methodology
```

Expected: no regression — existing tests should pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/methodology/sections/
git commit -m "refactor(methodology): export CONTENT_MARKDOWN constants per section"
```

## Task A.4: Methodology adapter — stringify sections to markdown

**Goal:** Build the adapter that combines per-section `CONTENT_MARKDOWN` exports into a single markdown document per methodology route.

**Files:**
- Create: `scripts/lib/methodology-to-markdown.ts`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts` (add a describe block).

- [ ] **Step 1: Write the failing test**

Append to `scripts/__tests__/generate-markdown-exports.test.ts`:

```ts
import { buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";

describe("buildMethodologyIndexMarkdown", () => {
  it("produces front-matter + section headings for /methodology/", () => {
    const md = buildMethodologyIndexMarkdown();
    expect(md).toMatch(/^---\ntitle: "Methodology/);
    expect(md).toContain("## Safety Scores Grading Methodology");
    expect(md).toContain("## Peg Stability Composite (PegScore)");
    expect(md).toContain("canonical: https://pharos.watch/methodology/");
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Create `scripts/lib/methodology-to-markdown.ts`:

```ts
import { CONTENT_MARKDOWN as SAFETY_SCORES } from "../../src/app/methodology/sections/core/safety-scores-section";
import { CONTENT_MARKDOWN as LIQUIDITY } from "../../src/app/methodology/sections/core/liquidity-section";
import { CONTENT_MARKDOWN as STABILITY_INDEX } from "../../src/app/methodology/sections/core/stability-index-section";
import { CONTENT_MARKDOWN as INFRASTRUCTURE } from "../../src/app/methodology/sections/core/infrastructure-section";
import { CONTENT_MARKDOWN as MINT_BURN_FLOW } from "../../src/app/methodology/sections/core/mint-burn-flow-section";
import { CONTENT_MARKDOWN as PEGSCORE_DEWS } from "../../src/app/methodology/sections/monitoring/pegscore-dews-section";
import { CONTENT_MARKDOWN as CHAIN_HEALTH } from "../../src/app/methodology/sections/monitoring/chain-health-section";
import { CONTENT_MARKDOWN as BLACKLIST } from "../../src/app/methodology/sections/monitoring/blacklist-tracker-section";
import { CONTENT_MARKDOWN as CONTAGION } from "../../src/app/methodology/sections/monitoring/contagion-stress-test-section";
import { CONTENT_MARKDOWN as YIELD } from "../../src/app/methodology/sections/monitoring/yield-intelligence-section";

const SECTIONS = [
  SAFETY_SCORES,
  LIQUIDITY,
  STABILITY_INDEX,
  INFRASTRUCTURE,
  MINT_BURN_FLOW,
  PEGSCORE_DEWS,
  CHAIN_HEALTH,
  BLACKLIST,
  CONTAGION,
  YIELD,
];

function frontMatter(attrs: Record<string, string>): string {
  const lines = Object.entries(attrs)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${lines}\n---\n\n`;
}

export function buildMethodologyIndexMarkdown(): string {
  const body = SECTIONS.join("\n\n");
  return (
    frontMatter({
      title: "Methodology: How Pharos Grades Stablecoins",
      canonical: "https://pharos.watch/methodology/",
      description:
        "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests.",
    }) +
    `# Methodology\n\n` +
    body +
    "\n"
  );
}
```

- [ ] **Step 4: Run to see it pass**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/methodology-to-markdown.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): methodology index adapter"
```

## Task A.5: Methodology changelog sub-pages — render to markdown

**Goal:** Each of the 9 methodology changelog routes (scoring, depeg, blacklist-tracker, liquidity-score, stability-index, mint-burn-flow, yield, pricing-pipeline, chain-health) gets a markdown variant built from its `entries` array. The data is already structured via `createMethodologyChangelogRoute` (`src/app/methodology/changelog-route-factory.tsx`) — use `mapMethodologyChangelogEntries`.

**Files:**
- Modify: `scripts/lib/methodology-to-markdown.ts`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { buildMethodologyChangelogMarkdown } from "../lib/methodology-to-markdown";

describe("buildMethodologyChangelogMarkdown", () => {
  it("emits front-matter + one heading per version entry", () => {
    const md = buildMethodologyChangelogMarkdown("scoring");
    expect(md).toMatch(/^---\ntitle: "Safety Scores Changelog/);
    // Arbitrary sentinel: Pharos safety score methodology is v6+ by 2026-04-19.
    expect(md).toMatch(/## v\d+\.\d+/);
    expect(md).toContain("canonical: https://pharos.watch/methodology/scoring-changelog/");
  });

  it.each([
    ["scoring", "/methodology/scoring-changelog/"],
    ["depeg", "/methodology/depeg-changelog/"],
    ["blacklist-tracker", "/methodology/blacklist-tracker-changelog/"],
    ["liquidity-score", "/methodology/liquidity-score-changelog/"],
    ["stability-index", "/methodology/stability-index-changelog/"],
    ["mint-burn-flow", "/methodology/mint-burn-flow-changelog/"],
    ["yield", "/methodology/yield-changelog/"],
    ["pricing-pipeline", "/methodology/pricing-pipeline-changelog/"],
    ["chain-health", "/methodology/chain-health-changelog/"],
  ])("renders %s changelog pointing at %s", (key, canonicalPath) => {
    const md = buildMethodologyChangelogMarkdown(key as never);
    expect(md).toContain(`canonical: https://pharos.watch${canonicalPath}`);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

In `scripts/lib/methodology-to-markdown.ts` append (importing each changelog entries array from `@shared/lib/`):

```ts
import { SAFETY_SCORE_CHANGELOG } from "../../shared/lib/safety-score-version";
// ... similarly for each of the other 8 changelog sources.

interface ChangelogEntry {
  version: string;
  title: string;
  date: string;
  summary: string;
  impact?: readonly string[];
}

const CHANGELOG_REGISTRY: Record<string, { title: string; path: string; entries: readonly ChangelogEntry[] }> = {
  scoring: {
    title: "Safety Scores Changelog",
    path: "/methodology/scoring-changelog/",
    entries: SAFETY_SCORE_CHANGELOG,
  },
  // ... 8 more keys
};

export type MethodologyChangelogKey = keyof typeof CHANGELOG_REGISTRY;

export function buildMethodologyChangelogMarkdown(key: MethodologyChangelogKey): string {
  const { title, path, entries } = CHANGELOG_REGISTRY[key];
  const sections = entries
    .map((e) => {
      const impactLines = (e.impact ?? []).map((line) => `- ${line}`).join("\n");
      return `## ${e.version} — ${e.title}\n\n**Effective:** ${e.date}\n\n${e.summary}\n\n${impactLines}`;
    })
    .join("\n\n");
  return (
    frontMatter({
      title,
      canonical: `https://pharos.watch${path}`,
      description: `${title} — Pharos methodology version history.`,
    }) +
    `# ${title}\n\n${sections}\n`
  );
}
```

Find the exact import paths by running `rg -n "CHANGELOG = \[" shared/lib` before editing. Each methodology changelog has a canonical array already consumed by the TSX route.

- [ ] **Step 4: Run to see tests pass**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS (10 cases including the initial one).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/methodology-to-markdown.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): methodology changelog adapters"
```

## Task A.6: Stablecoin detail markdown renderer

**Goal:** For each entry in `TRACKED_STABLECOINS`, render a markdown detail page using data from the JSON source + `data/ai-summaries.json`. This mirrors what `src/app/stablecoin/[id]/page.tsx` shows in the **build-time known** fields (name, symbol, flags, collateral, jurisdiction, contracts, peg mechanism, editorial summary). Live API fields (price, peg score, mint/burn flows) are NOT included — they are served by `/api/*` and would be stale in a cached markdown file.

**Files:**
- Modify: `scripts/lib/markdown-renderers.ts`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { renderStablecoinDetail } from "../lib/markdown-renderers";

describe("renderStablecoinDetail", () => {
  it("renders USDT with front-matter and contracts table", () => {
    const md = renderStablecoinDetail("usdt-tether");
    expect(md).toMatch(/^---\ntitle: "Tether \(USDT\) Stablecoin Analytics"/);
    expect(md).toContain("canonical: https://pharos.watch/stablecoin/usdt-tether/");
    expect(md).toContain("**Peg:** USD");
    expect(md).toContain("**Backing:** ");
    expect(md).toContain("## Contracts");
    expect(md).toContain("ethereum");
    expect(md).toContain("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("falls back gracefully for a coin without an AI summary", () => {
    // Pick an arbitrarily obscure tracked coin; test should not crash.
    const md = renderStablecoinDetail("xsgd-straitsx");
    expect(md).toContain("XSGD");
    expect(md).not.toMatch(/undefined/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `scripts/lib/markdown-renderers.ts`:

```ts
import { TRACKED_META_BY_ID } from "../../shared/lib/stablecoins";
import {
  GOVERNANCE_LABELS,
  BACKING_LABELS,
  PEG_LABELS_SHORT,
} from "../../shared/lib/classification";
import aiSummaries from "../../data/ai-summaries.json";

type Summary = { title: string; text: string; updatedAt: string };
const summaries = aiSummaries as Record<string, Summary>;

function frontMatterBlock(attrs: Record<string, string>): string {
  return (
    "---\n" +
    Object.entries(attrs)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n") +
    "\n---\n\n"
  );
}

export function renderStablecoinDetail(id: string): string {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin) throw new Error(`Unknown stablecoin id: ${id}`);

  const summary = summaries[id];
  const contracts = (coin.contracts ?? [])
    .map((c) => `| ${c.chain} | \`${c.address}\` | ${c.decimals ?? "—"} |`)
    .join("\n");

  const parts: string[] = [];
  parts.push(frontMatterBlock({
    title: `${coin.name} (${coin.symbol}) Stablecoin Analytics`,
    canonical: `https://pharos.watch/stablecoin/${id}/`,
    description: `Live analytics for ${coin.name} (${coin.symbol}). Peg, safety, liquidity, flows, and chain distribution.`,
    ...(summary?.updatedAt ? { dateModified: summary.updatedAt } : {}),
  }));
  parts.push(`# ${coin.name} (${coin.symbol})`);
  parts.push(
    `**Peg:** ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}`,
    `**Backing:** ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}`,
    `**Governance:** ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}`,
  );
  if (summary) {
    parts.push(`## Overview\n\n${summary.text}`);
  }
  if (coin.collateral) {
    parts.push(`## Collateral\n\n${coin.collateral}`);
  }
  if (coin.pegMechanism) {
    parts.push(`## Peg Mechanism\n\n${coin.pegMechanism}`);
  }
  if (contracts) {
    parts.push(
      `## Contracts\n\n| Chain | Address | Decimals |\n| --- | --- | --- |\n${contracts}`,
    );
  }
  parts.push(
    `## Live Data\n\nReal-time price, supply, peg score, and liquidity data live at https://api.pharos.watch/api/stablecoin/${id}.\n\nJSON is available; negotiate with \`Accept: application/json\`.`,
  );
  return parts.join("\n\n") + "\n";
}

export function* iterateStablecoinRoutes(): Generator<MarkdownRoute> {
  for (const [id] of TRACKED_META_BY_ID.entries()) {
    yield {
      path: `/stablecoin/${id}/`,
      body: renderStablecoinDetail(id),
    };
  }
}
```

If `TRACKED_META_BY_ID` does not expose `entries()`, use `TRACKED_STABLECOINS` instead (check `shared/lib/stablecoins.ts`).

- [ ] **Step 4: Run to see tests pass**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/markdown-renderers.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): stablecoin detail markdown renderer"
```

## Task A.7: Changelog + digest renderers

**Goal:** Render the weekly changelog index, per-entry weekly pages (if any routes exist — verify first), and the per-digest pages.

Note: `src/app/changelog/page.tsx` only exposes an index. There is no `/changelog/[week]/` dynamic route. So only one markdown route is produced for `/changelog/`. Confirm with `ls src/app/changelog/`.

The digest route is dynamic at `/digest/[date]/`; iterate `data/digests.json`.

**Files:**
- Modify: `scripts/lib/markdown-renderers.ts`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import {
  renderChangelogIndex,
  renderDigestDetail,
  iterateDigestRoutes,
} from "../lib/markdown-renderers";
import { changelogs } from "../../src/data/changelogs";
import digests from "../../data/digests.json";

describe("renderChangelogIndex", () => {
  it("emits a heading per changelog entry with date ranges", () => {
    const md = renderChangelogIndex(changelogs);
    expect(md).toMatch(/^---\ntitle: "Changelog: What's New on Pharos"/);
    expect(md).toContain("canonical: https://pharos.watch/changelog/");
    // Exactly one level-2 heading per entry
    const headings = md.match(/^## /gm) ?? [];
    expect(headings.length).toBe(changelogs.length);
  });
});

describe("renderDigestDetail", () => {
  it("produces front-matter + Executive Summary + Extended sections", () => {
    const latest = digests[0] as { date: string; title: string; text: string; extended: string; generatedAt: number };
    const md = renderDigestDetail(latest);
    expect(md).toContain(`canonical: https://pharos.watch/digest/${latest.date}/`);
    expect(md).toContain("## Executive Summary");
    expect(md).toContain(latest.text.slice(0, 30));
  });
});

describe("iterateDigestRoutes", () => {
  it("yields one route per digest", () => {
    const routes = Array.from(iterateDigestRoutes());
    expect(routes.length).toBe(digests.length);
    for (const r of routes) {
      expect(r.path).toMatch(/^\/digest\/.+\/$/);
    }
  });
});
```

- [ ] **Step 2: Run to see tests fail**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `scripts/lib/markdown-renderers.ts`:

```ts
import { changelogs as _changelogs } from "../../src/data/changelogs";
import type { ChangelogEntry } from "../../src/data/changelogs/types";
import digestsData from "../../data/digests.json";

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
  digestType?: "daily" | "weekly";
  editionNumber?: number;
}

export function renderChangelogIndex(entries: readonly ChangelogEntry[]): string {
  const sections = entries
    .map((e) => {
      const summaryLines = e.summary
        .map((s) => `- **${s.label}**: ${s.description}`)
        .join("\n");
      return `## ${e.dateRange.from} — ${e.dateRange.to}${
        e.headline ? `\n\n${e.headline}` : ""
      }\n\n${summaryLines}`;
    })
    .join("\n\n");
  return (
    frontMatterBlock({
      title: "Changelog: What's New on Pharos",
      canonical: "https://pharos.watch/changelog/",
      description: "Weekly release notes for Pharos.",
    }) +
    "# Changelog\n\n" +
    sections +
    "\n"
  );
}

export function renderDigestDetail(d: DigestEntry): string {
  const iso = new Date(d.generatedAt * 1000).toISOString();
  return (
    frontMatterBlock({
      title: `${d.title}`,
      canonical: `https://pharos.watch/digest/${d.date}/`,
      datePublished: iso,
      description: d.text.slice(0, 160),
    }) +
    `# ${d.title}\n\n## Executive Summary\n\n${d.text}\n\n## Extended\n\n${d.extended}\n`
  );
}

export function* iterateDigestRoutes(): Generator<MarkdownRoute> {
  for (const d of digestsData as DigestEntry[]) {
    yield { path: `/digest/${d.date}/`, body: renderDigestDetail(d) };
  }
}
```

- [ ] **Step 4: Run to see tests pass**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/markdown-renderers.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): changelog and digest renderers"
```

## Task A.8: Wire the generator `main()` — write all routes

**Goal:** Complete the top-level generator to emit markdown for all four route classes: methodology index, methodology changelogs (9), stablecoin detail (191), changelog index, digests.

**Files:**
- Modify: `scripts/generate-markdown-exports.ts`.

- [ ] **Step 1: Rewrite `main()`**

Replace the body of `main()`:

```ts
import {
  buildMethodologyIndexMarkdown,
  buildMethodologyChangelogMarkdown,
} from "./lib/methodology-to-markdown";
import {
  iterateStablecoinRoutes,
  renderChangelogIndex,
  iterateDigestRoutes,
} from "./lib/markdown-renderers";
import { changelogs } from "../src/data/changelogs";

const CHANGELOG_KEYS = [
  "scoring",
  "depeg",
  "blacklist-tracker",
  "liquidity-score",
  "stability-index",
  "mint-burn-flow",
  "yield",
  "pricing-pipeline",
  "chain-health",
] as const;

const CHANGELOG_PATHS: Record<(typeof CHANGELOG_KEYS)[number], string> = {
  scoring: "/methodology/scoring-changelog/",
  depeg: "/methodology/depeg-changelog/",
  "blacklist-tracker": "/methodology/blacklist-tracker-changelog/",
  "liquidity-score": "/methodology/liquidity-score-changelog/",
  "stability-index": "/methodology/stability-index-changelog/",
  "mint-burn-flow": "/methodology/mint-burn-flow-changelog/",
  yield: "/methodology/yield-changelog/",
  "pricing-pipeline": "/methodology/pricing-pipeline-changelog/",
  "chain-health": "/methodology/chain-health-changelog/",
};

async function main() {
  let count = 0;

  writeMarkdownRoute(OUT_DIR, {
    path: "/methodology/",
    body: buildMethodologyIndexMarkdown(),
  });
  count++;

  for (const key of CHANGELOG_KEYS) {
    writeMarkdownRoute(OUT_DIR, {
      path: CHANGELOG_PATHS[key],
      body: buildMethodologyChangelogMarkdown(key),
    });
    count++;
  }

  for (const route of iterateStablecoinRoutes()) {
    writeMarkdownRoute(OUT_DIR, route);
    count++;
  }

  writeMarkdownRoute(OUT_DIR, {
    path: "/changelog/",
    body: renderChangelogIndex(changelogs),
  });
  count++;

  for (const route of iterateDigestRoutes()) {
    writeMarkdownRoute(OUT_DIR, route);
    count++;
  }

  console.log(`generate-markdown-exports: wrote ${count} markdown variants`);
}
```

- [ ] **Step 2: Run the build**

```bash
npm run build
```

Expected: clean exit. Output includes line like `generate-markdown-exports: wrote 208 markdown variants` (1 methodology index + 9 changelogs + 191 stablecoins + 1 changelog index + ~6 digests).

- [ ] **Step 3: Spot-check the output**

```bash
ls out/methodology/index.md out/stablecoin/usdt-tether/index.md out/digest/
head -20 out/stablecoin/usdt-tether/index.md
```

Expected: files exist, front-matter renders correctly, no `undefined` tokens.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-markdown-exports.ts
git commit -m "feat(md-gen): emit markdown variants for all four route classes"
```

## Task A.9: Pages Function middleware — content negotiation

**Goal:** `functions/_middleware.ts` inspects each GET, conditionally serves the colocated `.md` variant, and attaches `Vary: Accept` to all responses.

**Files:**
- Create: `functions/_middleware.ts`.

- [ ] **Step 1: Write the failing test**

Create `functions/__tests__/middleware.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { onRequest } from "../_middleware";

function makeAssetsFetch(files: Record<string, string>) {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = new URL(url).pathname;
    const body = files[path];
    if (body === undefined) {
      return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/html" } });
    }
    const type = path.endsWith(".md") ? "text/markdown" : "text/html";
    return new Response(body, { status: 200, headers: { "Content-Type": type } });
  });
}

function ctx(request: Request, assetsFiles: Record<string, string>) {
  const env = { ASSETS: { fetch: makeAssetsFetch(assetsFiles) } };
  const next = vi.fn(async () => {
    const asPath = new URL(request.url).pathname;
    const body = assetsFiles[asPath] ?? assetsFiles[asPath + "index.html"];
    if (!body) return new Response("Not Found", { status: 404 });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  });
  return { request, env, next };
}

describe("pages middleware markdown negotiation", () => {
  const files = {
    "/stablecoin/usdt-tether/index.html": "<html>USDT HTML</html>",
    "/stablecoin/usdt-tether/index.md": "# USDT Markdown",
  };

  it("serves markdown when Accept: text/markdown matches a variant", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, files));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(await res.text()).toBe("# USDT Markdown");
  });

  it("falls through to HTML when Accept header is missing", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/");
    const res = await onRequest(ctx(req, files));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Vary")).toContain("Accept");
  });

  it("falls through to HTML when Accept prefers HTML", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      headers: { Accept: "text/html,text/markdown;q=0.5" },
    });
    const res = await onRequest(ctx(req, files));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("does not rewrite to markdown for unsupported route prefixes", async () => {
    const req = new Request("https://pharos.watch/about/", {
      headers: { Accept: "text/markdown" },
    });
    const files = { "/about/index.html": "<html>About</html>" };
    const res = await onRequest(ctx(req, files));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Vary")).toContain("Accept");
  });

  it("ignores /api/* and passes through", async () => {
    const req = new Request("https://pharos.watch/api/stablecoins", {
      headers: { Accept: "text/markdown" },
    });
    const { next, env } = ctx(req, {});
    await onRequest({ request: req, env, next });
    expect(next).toHaveBeenCalled();
  });

  it("falls through gracefully when the .md variant is missing", async () => {
    const req = new Request("https://pharos.watch/stablecoin/not-found/", {
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, { "/stablecoin/not-found/index.html": "<html>HTML</html>" }));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
npm test -- functions/__tests__/middleware.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `functions/_middleware.ts`:

```ts
interface MiddlewareEnv {
  ASSETS?: { fetch: typeof fetch };
}

interface MiddlewareContext {
  request: Request;
  env: MiddlewareEnv;
  next: (input?: Request) => Promise<Response>;
}

const MARKDOWN_ROUTE_PREFIXES = [
  "/methodology/",
  "/stablecoin/",
  "/changelog/",
  "/digest/",
  "/docs/",
];

const PASSTHROUGH_PREFIXES = ["/api/", "/_site-data/", "/admin/", "/_next/"];

function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const entries = accept
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [type, ...params] = entry.split(";").map((p) => p.trim());
      const qParam = params.find((p) => p.startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    });

  const markdownQ = Math.max(
    ...entries
      .filter((e) => e.type === "text/markdown" || e.type === "text/x-markdown")
      .map((e) => e.q),
    -Infinity,
  );
  if (!Number.isFinite(markdownQ)) return false;

  const htmlQ = Math.max(
    ...entries.filter((e) => e.type === "text/html").map((e) => e.q),
    -Infinity,
  );
  const htmlEffective = Number.isFinite(htmlQ) ? htmlQ : -Infinity;

  return markdownQ >= htmlEffective;
}

function matchesMarkdownRoute(pathname: string): boolean {
  if (!pathname.endsWith("/")) return false;
  return MARKDOWN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function matchesPassthrough(pathname: string): boolean {
  return PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function withVaryAccept(response: Response): Response {
  const varyExisting = response.headers.get("Vary");
  if (varyExisting?.toLowerCase().includes("accept")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Vary", varyExisting ? `${varyExisting}, Accept` : "Accept");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = async (ctx: MiddlewareContext): Promise<Response> => {
  const url = new URL(ctx.request.url);

  if (matchesPassthrough(url.pathname) || ctx.request.method !== "GET") {
    return ctx.next();
  }

  const shouldTryMarkdown =
    matchesMarkdownRoute(url.pathname) && prefersMarkdown(ctx.request.headers.get("Accept"));

  if (shouldTryMarkdown && ctx.env.ASSETS) {
    const mdUrl = new URL(url);
    mdUrl.pathname = url.pathname + "index.md";
    const mdResponse = await ctx.env.ASSETS.fetch(new Request(mdUrl.toString(), { method: "GET" }));
    if (mdResponse.ok) {
      const headers = new Headers(mdResponse.headers);
      headers.set("Content-Type", "text/markdown; charset=utf-8");
      headers.set("Vary", "Accept");
      return new Response(mdResponse.body, {
        status: mdResponse.status,
        statusText: mdResponse.statusText,
        headers,
      });
    }
  }

  const fallback = await ctx.next();
  return withVaryAccept(fallback);
};
```

Note: In the test harness, `ctx.env.ASSETS.fetch` is called with a Request; the real Cloudflare runtime also accepts this signature. If the test fixture's `next` pattern does not match the prod `env.ASSETS.fetch`, the middleware still uses `env.ASSETS.fetch` for the `.md` probe.

- [ ] **Step 4: Run tests to see them pass**

```bash
npm test -- functions/__tests__/middleware.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add functions/_middleware.ts functions/__tests__/middleware.test.ts
git commit -m "feat(pages): add content-negotiation middleware"
```

## Task A.10: Integration smoke test via wrangler pages dev

**Goal:** Boot the Pages functions locally against a built `out/` and confirm real negotiation behavior.

**Files:** none (manual verification with brief notes in the plan output).

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: clean build, markdown files present under `out/`.

- [ ] **Step 2: Boot wrangler pages dev**

```bash
npx wrangler pages dev out --compatibility-date=2026-04-18
```

The command runs in the foreground on `http://127.0.0.1:8788`.

- [ ] **Step 3: Curl three routes with markdown Accept**

In a second terminal:

```bash
curl -sI -H "Accept: text/markdown" http://127.0.0.1:8788/methodology/ | head -20
curl -s  -H "Accept: text/markdown" http://127.0.0.1:8788/stablecoin/usdt-tether/ | head -40
curl -sI                              http://127.0.0.1:8788/stablecoin/usdt-tether/ | head -20
```

Expected:
- First: `Content-Type: text/markdown` and `Vary: Accept`.
- Second: markdown body beginning with `---\ntitle: "Tether (USDT)`.
- Third: `Content-Type: text/html` and `Vary: Accept`.

- [ ] **Step 4: Stop wrangler and commit findings**

No file changes expected. Commit a short PR note in the final PR body — no task-level commit.

## Task A.11: Snapshot test to prevent markdown drift

**Goal:** Add snapshot tests for 3 representative markdown outputs to catch accidental changes.

**Files:**
- Create: `scripts/__tests__/fixtures/markdown/usdt-tether.md`, `methodology-index.md`, `changelog-index.md`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Generate the fixtures once**

```bash
npm run build
cp out/stablecoin/usdt-tether/index.md scripts/__tests__/fixtures/markdown/usdt-tether.md
cp out/methodology/index.md scripts/__tests__/fixtures/markdown/methodology-index.md
cp out/changelog/index.md scripts/__tests__/fixtures/markdown/changelog-index.md
```

- [ ] **Step 2: Add the snapshot tests**

Append to `scripts/__tests__/generate-markdown-exports.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import { renderStablecoinDetail, renderChangelogIndex } from "../lib/markdown-renderers";
import { changelogs } from "../../src/data/changelogs";

const FIXTURE_DIR = join(__dirname, "fixtures", "markdown");

describe("markdown output snapshots", () => {
  it("stablecoin detail for usdt-tether matches fixture", () => {
    expect(renderStablecoinDetail("usdt-tether")).toBe(
      readFileSync(join(FIXTURE_DIR, "usdt-tether.md"), "utf-8"),
    );
  });

  it("methodology index matches fixture", () => {
    expect(buildMethodologyIndexMarkdown()).toBe(
      readFileSync(join(FIXTURE_DIR, "methodology-index.md"), "utf-8"),
    );
  });

  it("changelog index matches fixture", () => {
    expect(renderChangelogIndex(changelogs)).toBe(
      readFileSync(join(FIXTURE_DIR, "changelog-index.md"), "utf-8"),
    );
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Expected: PASS.

- [ ] **Step 4: Document how to update fixtures**

Add a comment at the top of the describe block:

```ts
// To refresh snapshots after an intentional change: run `npm run build`, then
// copy `out/<route>/index.md` over the corresponding fixture file and commit.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/fixtures/ scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "test(md-gen): snapshot fixtures for 3 representative routes"
```

## Task A.12: Documentation and merge-gate wiring

**Goal:** Document the content-negotiation protocol and make sure the merge gate picks up changes to the new files.

**Files:**
- Modify: `docs/architecture.md` — add a `Content Negotiation` section.
- Modify: `src/app/about/api/page.tsx` — add a small paragraph to the copy.
- Modify: `scripts/lib/deploy-impact.mjs` — verify coverage; add paths if missing.

- [ ] **Step 1: Inspect the existing deploy-impact matchers**

```bash
cat scripts/lib/deploy-impact.mjs | head -60
```

Confirm whether `scripts/**`, `functions/**`, and `shared/**` are already covered. Most likely yes. If new paths are not covered, add them.

- [ ] **Step 2: Add architecture section**

In `docs/architecture.md`, add after the existing `API Endpoints` table:

```markdown
## Content Negotiation (Markdown for Agents)

Pharos honors `Accept: text/markdown` on these route classes:

- `/methodology/` (index + 9 changelog subpages)
- `/stablecoin/<id>/` (all 191 tracked coins)
- `/changelog/` (weekly release notes index)
- `/digest/<date>/` (daily and weekly digest entries)
- `/docs/<slug>/` (public doc archive)

Agents receive a pre-rendered `.md` variant. `Vary: Accept` is attached to every response by `functions/_middleware.ts`. The markdown variants are generated at build time by `scripts/generate-markdown-exports.ts` and shipped as `out/<route>/index.md` alongside HTML. Live data (price, flows, peg score) is not embedded — agents fetch `/api/*` directly.
```

- [ ] **Step 3: Update the about/api page**

In `src/app/about/api/page.tsx`, locate a suitable place and add:

```tsx
<p>
  Pharos supports <code>Accept: text/markdown</code> content negotiation on methodology, stablecoin, changelog, and digest routes. Agents that prefer markdown receive a pre-rendered variant with the same canonical URL. Live numeric data remains at the API endpoints documented above.
</p>
```

- [ ] **Step 4: Run the doc-count and verified-link checks**

```bash
npm run check:doc-counts
npm run check:verified-doc-links
```

Expected: both exit 0.

- [ ] **Step 5: Run the full merge gate**

```bash
npm run test:merge-gate
```

Expected: exit 0. If the gate complains that `generate-markdown-exports.ts` output is uncovered or a type-check fails, fix inline.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md src/app/about/api/page.tsx scripts/lib/deploy-impact.mjs
git commit -m "docs: explain markdown content negotiation"
```

## Task A.13: Open Feature A PR

- [ ] **Step 1: Push branch, open PR with body covering:**
  - Summary of content-negotiation feature (3 sentences max)
  - List of route classes covered
  - Test plan: curl examples from Task A.10
  - Rollback plan: delete `functions/_middleware.ts` and revert `prebuild` change.

- [ ] **Step 2: Wait for CI green, merge squash.**

---

# FEATURE B: Public `/docs/*` Routes

Ships second. Target: days 6-10. **Begin only after Feature A is merged.**

## Task B.1: Curate the public docs allowlist

**Goal:** Create `shared/lib/public-docs.ts` — the single source of truth for which `docs/*.md` files are public, their slugs, their titles, and their grouping.

**Files:**
- Create: `shared/lib/public-docs.ts`.
- Create: `shared/lib/__tests__/public-docs.test.ts`.

**Initial allowlist (24 docs):**

| Source | Public slug | Group |
|---|---|---|
| `docs/architecture.md` | `architecture` | system |
| `docs/api-reference.md` | `api-reference` | system |
| `docs/api-endpoint-authoring.md` | `api-endpoint-authoring` | system |
| `docs/data-flow-map.md` | `data-flow-map` | system |
| `docs/data-pipeline.md` | `data-pipeline` | system |
| `docs/worker-infrastructure.md` | `worker-infrastructure` | system |
| `docs/worker-and-api-limits.md` | `worker-and-api-limits` | system |
| `docs/testing.md` | `testing` | system |
| `docs/deployment-process.md` | `deployment-process` | system |
| `docs/classification.md` | `classification` | methodology |
| `docs/pricing-pipeline.md` | `pricing-pipeline` | methodology |
| `docs/depeg-detection.md` | `depeg-detection` | methodology |
| `docs/dews.md` | `dews` | methodology |
| `docs/dex-liquidity.md` | `dex-liquidity` | methodology |
| `docs/stability-index.md` | `stability-index` | methodology |
| `docs/report-cards.md` | `report-cards` | methodology |
| `docs/redemption-backstops.md` | `redemption-backstops` | methodology |
| `docs/chain-health.md` | `chain-health` | methodology |
| `docs/mint-burn-flows.md` | `mint-burn-flows` | methodology |
| `docs/yield-intelligence.md` | `yield-intelligence` | methodology |
| `docs/shadow-stablecoins.md` | `shadow-stablecoins` | methodology |
| `docs/design-context.md` | `design-context` | design |
| `docs/design-language.md` | `design-language` | design |
| `docs/design-tokens.md` | `design-tokens` | design |

**Explicitly NOT included** (internal / agent-authored / drift-prone): `agent-code-map.md`, `agent-task-router.md`, `api-endpoint-authoring.md` (debatable — consider for system group), `doc-ownership.json`, `documentation-map-*.tsv`, all `*-timeline.md` files (they're history, better as methodology changelog markdown on the existing routes), all `runbooks/*` (operator-only), `*-page.md` route-contract docs (describe internal page structure, not a public explainer), `live-reserves.md`, `bluechip-ratings.md`, `blacklist-tracker.md`, `stablecoin-detail-page.md`, `homepage.md`, `start-page.md`, `coverage-page.md`, `cemetery-and-compare.md`, `chains-page.md`, `api-page.md`, `methodology-page.md`, `portfolio-page.md`, `privacy-page.md`, `funding-page.md`, `upcoming-page.md`, `operator-origin-access.md`, `digest-pipeline.md`, `feedback-pipeline.md`, `supply-snapshot.md`, `status-dashboard.md`, `telegram-alerts.md`, `scripts.md`, `yield-intelligence-operations.md`, `dependency-map.md`, `stablecoin-data.md`.

Open question — flagged for user input: should the `*-page.md` route-contract docs go public? They are internal-ish but technically accurate. **Default: exclude.** If the user wants them in, add them to the allowlist and move on.

- [ ] **Step 1: Write the failing test**

Create `shared/lib/__tests__/public-docs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DOCS, DOC_GROUPS } from "../public-docs";

const DOCS_DIR = join(__dirname, "..", "..", "..", "docs");

describe("PUBLIC_DOCS registry", () => {
  it("contains at least 20 entries", () => {
    expect(PUBLIC_DOCS.length).toBeGreaterThanOrEqual(20);
  });

  it("every entry points to an existing file", () => {
    for (const doc of PUBLIC_DOCS) {
      expect(existsSync(join(DOCS_DIR, doc.source))).toBe(true);
    }
  });

  it("every entry has a unique slug", () => {
    const slugs = PUBLIC_DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("slugs are url-safe (kebab-case, alphanumeric + hyphen)", () => {
    for (const doc of PUBLIC_DOCS) {
      expect(doc.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every entry belongs to a known group", () => {
    for (const doc of PUBLIC_DOCS) {
      expect(DOC_GROUPS).toContain(doc.group);
    }
  });

  it("every source file starts with an H1 heading", () => {
    for (const doc of PUBLIC_DOCS) {
      const body = readFileSync(join(DOCS_DIR, doc.source), "utf-8");
      expect(body.trim()).toMatch(/^#\s+/);
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
npm test -- shared/lib/__tests__/public-docs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `shared/lib/public-docs.ts`:

```ts
export const DOC_GROUPS = ["system", "methodology", "design"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export interface PublicDoc {
  /** Filename within `/docs/` (relative). */
  source: string;
  /** URL slug at `/docs/<slug>/`. */
  slug: string;
  /** Short human title for the index page. */
  title: string;
  /** One-sentence summary for the index page. */
  summary: string;
  /** Group for the index-page grouping + sidebar. */
  group: DocGroup;
}

export const PUBLIC_DOCS: readonly PublicDoc[] = [
  { source: "architecture.md",       slug: "architecture",       title: "Architecture",                         summary: "Curated file tree, API inventory, and SEO surface.",               group: "system" },
  { source: "api-reference.md",      slug: "api-reference",      title: "API Reference",                        summary: "Public and admin API contract reference.",                         group: "system" },
  { source: "api-endpoint-authoring.md", slug: "api-endpoint-authoring", title: "API Endpoint Authoring", summary: "Shared registry, auth, cache, and hook checklist.",                group: "system" },
  { source: "data-flow-map.md",      slug: "data-flow-map",      title: "Data Flow Map",                        summary: "External source → cron → D1 → API → hook → page mapping.",        group: "system" },
  { source: "data-pipeline.md",      slug: "data-pipeline",      title: "Data Pipeline",                        summary: "Stablecoin sync, price enrichment, FX/metal rates.",               group: "system" },
  { source: "worker-infrastructure.md", slug: "worker-infrastructure", title: "Worker Infrastructure",         summary: "Worker env bindings, cron slots, cache and auth behavior.",        group: "system" },
  { source: "worker-and-api-limits.md", slug: "worker-and-api-limits", title: "Worker and API Limits",          summary: "Runtime budgets, throttle constants, and provider assumptions.",    group: "system" },
  { source: "testing.md",            slug: "testing",            title: "Testing",                              summary: "Test commands, CI gates, coverage thresholds, and helpers.",       group: "system" },
  { source: "deployment-process.md", slug: "deployment-process", title: "Deployment Process",                   summary: "Local merge gate, worktree flow, and CI deploy sequence.",         group: "system" },
  { source: "classification.md",     slug: "classification",     title: "Classification",                       summary: "Classification system, peg handling, and commodity treatment.",    group: "methodology" },
  { source: "pricing-pipeline.md",   slug: "pricing-pipeline",   title: "Pricing Pipeline",                     summary: "Live-price consensus, overrides, and fallback enrichment.",        group: "methodology" },
  { source: "depeg-detection.md",    slug: "depeg-detection",    title: "Depeg Detection",                      summary: "Two-stage detection, confirmation, and peg score inputs.",         group: "methodology" },
  { source: "dews.md",               slug: "dews",               title: "DEWS",                                 summary: "DEWS formula, sub-signals, bands, and API contract.",              group: "methodology" },
  { source: "dex-liquidity.md",      slug: "dex-liquidity",      title: "DEX Liquidity",                        summary: "Liquidity score, discovery pipeline, and cross-validation.",       group: "methodology" },
  { source: "stability-index.md",    slug: "stability-index",    title: "Pharos Stability Index",               summary: "PSI formula, bands, storage, and API surface.",                    group: "methodology" },
  { source: "report-cards.md",       slug: "report-cards",       title: "Report Cards",                         summary: "Report-card scoring, portfolio analyzer, and stress test.",        group: "methodology" },
  { source: "redemption-backstops.md", slug: "redemption-backstops", title: "Redemption Backstops",             summary: "Redemption routes, effective-exit scoring, and storage.",          group: "methodology" },
  { source: "chain-health.md",       slug: "chain-health",       title: "Chain Health",                         summary: "Chain Health Score inputs, formula, factors, and bands.",          group: "methodology" },
  { source: "mint-burn-flows.md",    slug: "mint-burn-flows",    title: "Mint Burn Flows",                      summary: "Mint/burn ingestion, scoring, and admin backfills.",               group: "methodology" },
  { source: "yield-intelligence.md", slug: "yield-intelligence", title: "Yield Intelligence",                   summary: "APY resolution, PYS scoring, and warning signals.",                group: "methodology" },
  { source: "shadow-stablecoins.md", slug: "shadow-stablecoins", title: "Shadow Stablecoins",                   summary: "PSI-only shadow asset boundary and UI exclusion rules.",           group: "methodology" },
  { source: "design-context.md",     slug: "design-context",     title: "Design Context",                       summary: "User, brand, and product-direction baseline.",                     group: "design" },
  { source: "design-language.md",    slug: "design-language",    title: "Design Language",                      summary: "Live UI patterns, typography, spacing, and responsive rules.",     group: "design" },
  { source: "design-tokens.md",      slug: "design-tokens",      title: "Design Tokens",                        summary: "Token layers and CSS variable architecture.",                      group: "design" },
];
```

- [ ] **Step 4: Run to see tests pass**

```bash
npm test -- shared/lib/__tests__/public-docs.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/lib/public-docs.ts shared/lib/__tests__/public-docs.test.ts
git commit -m "feat(docs): add PUBLIC_DOCS allowlist"
```

## Task B.2: Install MDX dependencies

**Goal:** Add `next-mdx-remote` and configure it for RSC under `output: "export"`.

**Files:**
- Modify: `package.json`.

- [ ] **Step 1: Install**

```bash
npm install next-mdx-remote@^5 rehype-slug@^6 rehype-autolink-headings@^7
```

(`remark-gfm` was installed in Task A.1.)

Expected: new deps in `package.json`. If peer-dep warnings appear for `react@19`, note them — `next-mdx-remote@5+` supports React 19. If it does not, pin to `next-mdx-remote@^4.5` and adjust import to the default export.

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add next-mdx-remote and rehype plugins for /docs"
```

## Task B.3: Generate docs metadata at build time

**Goal:** Extend `scripts/generate-markdown-exports.ts` to also emit `src/generated/docs-metadata.json` with per-doc `dateModified` (via git log).

**Files:**
- Modify: `scripts/generate-markdown-exports.ts`.
- Create: `src/generated/docs-metadata.json` (written by build).
- Modify: `.gitignore` — ensure `src/generated/` is ignored (if the project convention is to commit generated files, skip this step; check the existing `sitemap-dates.json` for the pattern).

- [ ] **Step 1: Check the existing convention**

```bash
git ls-files src/generated/ | head
```

If `sitemap-dates.json` is tracked, commit `docs-metadata.json` too. If it's gitignored, so is `docs-metadata.json`.

- [ ] **Step 2: Add generation logic**

Append to `scripts/generate-markdown-exports.ts`:

```ts
import { execSync } from "node:child_process";
import { PUBLIC_DOCS } from "../shared/lib/public-docs";

interface DocMetadata {
  dateModified: string;
  dateCreated: string;
}

function getGitDate(filePath: string, flag: "%aI" | "%ai"): string {
  try {
    return (
      execSync(`git log -1 --format=${flag} -- "${filePath}"`, { encoding: "utf-8" }).trim() ||
      new Date().toISOString()
    );
  } catch {
    return new Date().toISOString();
  }
}

function generateDocsMetadata(): void {
  const result: Record<string, DocMetadata> = {};
  for (const doc of PUBLIC_DOCS) {
    const filePath = join(__dirname, "..", "docs", doc.source);
    result[doc.slug] = {
      dateModified: getGitDate(filePath, "%aI"),
      dateCreated:
        execSync(
          `git log --reverse --format=%aI -- "${filePath}" | head -n 1`,
          { encoding: "utf-8" },
        ).trim() || new Date().toISOString(),
    };
  }
  const outputPath = join(__dirname, "..", "src", "generated", "docs-metadata.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
}
```

Call `generateDocsMetadata()` at the top of `main()`. Run before any route writing so the docs route can consume it.

- [ ] **Step 3: Run build and inspect output**

```bash
npm run build
cat src/generated/docs-metadata.json | head
```

Expected: JSON with 24 entries, each with `dateModified` and `dateCreated`.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-markdown-exports.ts
# If generated file is tracked:
git add src/generated/docs-metadata.json
git commit -m "feat(md-gen): emit per-doc dateModified metadata"
```

## Task B.4: Docs dynamic route — `/docs/[slug]/`

**Goal:** Create `src/app/docs/[slug]/page.tsx` that statically renders one page per `PUBLIC_DOCS` entry, reading the markdown, rendering via `next-mdx-remote/rsc`, and wrapping in `FeaturePageShell`.

**Files:**
- Create: `src/app/docs/[slug]/page.tsx`.

- [ ] **Step 1: Implement**

```tsx
import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

const BY_SLUG = new Map(PUBLIC_DOCS.map((d) => [d.slug, d]));
const DOCS_DIR = path.join(process.cwd(), "docs");

export function generateStaticParams() {
  return PUBLIC_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = BY_SLUG.get(slug);
  if (!doc) return { title: "Doc Not Found" };
  return {
    title: `${doc.title} — Pharos Docs`,
    description: doc.summary,
    alternates: { canonical: `/docs/${slug}/` },
    openGraph: {
      title: `${doc.title} — Pharos Docs`,
      description: doc.summary,
      url: `/docs/${slug}/`,
      type: "article",
    },
  };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = BY_SLUG.get(slug);
  if (!doc) notFound();

  const source = fs.readFileSync(path.join(DOCS_DIR, doc.source), "utf-8");
  const meta = (docsMetadata as Record<string, { dateModified: string; dateCreated: string }>)[slug];

  return (
    <FeaturePageShell
      breadcrumbName={doc.title}
      path={`/docs/${slug}/`}
      title={doc.title}
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[doc.summary]}
    >
      <BreadcrumbJsonLd name={doc.title} path={`/docs/${slug}/`} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: doc.title,
            description: doc.summary,
            datePublished: meta?.dateCreated,
            dateModified: meta?.dateModified,
            author: { "@type": "Organization", name: "Pharos", url: SITE_URL },
            publisher: {
              "@type": "Organization",
              name: "Pharos",
              url: SITE_URL,
              logo: `${SITE_URL}/pharos-icon.png`,
            },
            mainEntityOfPage: `${SITE_URL}/docs/${slug}/`,
          }),
        }}
      />
      <article className="prose prose-invert max-w-none">
        <MDXRemote
          source={source}
          options={{
            mdxOptions: {
              remarkPlugins: [remarkGfm],
              rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
            },
          }}
        />
      </article>
    </FeaturePageShell>
  );
}
```

**Note: Breadcrumb depth** — this uses the existing 2-level `BreadcrumbJsonLd`. If Week 1 shipped the N-level extension, swap in the N-level call: `<BreadcrumbJsonLd items={[{ name: "Docs", path: "/docs/" }, { name: doc.title, path: \`/docs/\${slug}/\` }]} />`. Check `src/components/breadcrumb-json-ld.tsx` before committing. Default to 2-level if the N-level API is not present (which is a mild degradation but not a blocker).

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: 24 new pages under `out/docs/<slug>/index.html`. If build fails because `next-mdx-remote/rsc` does not emit as static HTML under `output: "export"`, fall back to parsing with `remark` + `remark-html` server-side and injecting the resulting HTML via `dangerouslySetInnerHTML`. See Task B.5 for the contingency.

- [ ] **Step 4: Spot check**

```bash
head -40 out/docs/architecture/index.html
```

Expected: Pharos chrome + rendered architecture content.

- [ ] **Step 5: Commit**

```bash
git add src/app/docs/[slug]/page.tsx
git commit -m "feat(docs): add /docs/[slug]/ dynamic route"
```

## Task B.5: Contingency — MDX static-export fallback

**Goal:** Only execute if Task B.4 `npm run build` fails because `next-mdx-remote/rsc` emits dynamic output that `output: "export"` rejects.

**Files (if executed):**
- Replace `MDXRemote` usage with a server-side `remark`/`remark-html` pipeline.

- [ ] **Step 1: Install fallback deps**

```bash
npm install --save remark remark-html
```

- [ ] **Step 2: Refactor**

Replace the `<MDXRemote ... />` block in `src/app/docs/[slug]/page.tsx` with:

```tsx
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";

// ... inside DocPage, replace MDXRemote block with:
const html = String(
  await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypeStringify)
    .process(source),
);
// ...
<article className="prose prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
```

This processes markdown → HTML entirely at build time, which is compatible with `output: "export"`.

- [ ] **Step 3: Rebuild and retest**

```bash
npm run build
```

Expected: success. If this also fails, escalate: the issue is elsewhere.

- [ ] **Step 4: Commit (only if needed)**

```bash
git add package.json package-lock.json src/app/docs/[slug]/page.tsx
git commit -m "fix(docs): use remark pipeline for static-export compatibility"
```

## Task B.6: Docs index page — `/docs/`

**Goal:** `src/app/docs/page.tsx` lists every `PUBLIC_DOCS` entry grouped by `DOC_GROUPS`.

**Files:**
- Create: `src/app/docs/page.tsx`.

- [ ] **Step 1: Implement**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PUBLIC_DOCS, DOC_GROUPS } from "@shared/lib/public-docs";

export const metadata: Metadata = buildPageMetadata({
  title: "Docs — Pharos Documentation Archive",
  description:
    "Architectural and methodology documentation for the Pharos stablecoin analytics platform.",
  canonical: "/docs/",
});

const GROUP_TITLES: Record<(typeof DOC_GROUPS)[number], string> = {
  system: "System and Operations",
  methodology: "Methodology",
  design: "Design",
};

export default function DocsIndexPage() {
  const byGroup = Object.fromEntries(
    DOC_GROUPS.map((g) => [g, PUBLIC_DOCS.filter((d) => d.group === g)]),
  ) as Record<(typeof DOC_GROUPS)[number], typeof PUBLIC_DOCS>;

  return (
    <FeaturePageShell
      breadcrumbName="Docs"
      path="/docs/"
      title="Documentation"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[
        "Architectural, methodology, and design documentation for Pharos. Human-readable companions to the /methodology/, /about/, and /about/api/ surfaces. Machine-readable via `Accept: text/markdown`.",
      ]}
    >
      {DOC_GROUPS.map((group) => (
        <section key={group} className="mb-10">
          <h2 className="text-xl font-semibold">{GROUP_TITLES[group]}</h2>
          <ul className="mt-4 space-y-3">
            {byGroup[group].map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={`/docs/${doc.slug}/`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {doc.title}
                </Link>
                <p className="text-sm text-muted-foreground">{doc.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </FeaturePageShell>
  );
}
```

- [ ] **Step 2: Type-check + build**

```bash
npm run typecheck && npm run build
```

Expected: `out/docs/index.html` exists.

- [ ] **Step 3: Commit**

```bash
git add src/app/docs/page.tsx
git commit -m "feat(docs): add /docs/ index page"
```

## Task B.7: Markdown variants for docs routes

**Goal:** Generator extension — write `out/docs/<slug>/index.md` as a straight copy of the source doc with a front-matter block prepended. The middleware from Feature A already covers `/docs/` in its allowlist.

**Files:**
- Modify: `scripts/generate-markdown-exports.ts`.
- Modify: `scripts/lib/markdown-renderers.ts`.
- Modify: `scripts/__tests__/generate-markdown-exports.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { renderDocMarkdown } from "../lib/markdown-renderers";

describe("renderDocMarkdown", () => {
  it("prepends front-matter to a doc source", () => {
    const md = renderDocMarkdown({
      source: "architecture.md",
      slug: "architecture",
      title: "Architecture",
      summary: "Curated file tree, API inventory, and SEO surface.",
      group: "system",
    });
    expect(md).toMatch(/^---\ntitle: "Architecture/);
    expect(md).toContain("canonical: https://pharos.watch/docs/architecture/");
    expect(md).toContain("# Architecture");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `scripts/lib/markdown-renderers.ts`:

```ts
import { readFileSync as rfs } from "node:fs";
import { join as pjoin } from "node:path";
import type { PublicDoc } from "../../shared/lib/public-docs";

const REPO_ROOT = pjoin(__dirname, "..", "..");

export function renderDocMarkdown(doc: PublicDoc): string {
  const body = rfs(pjoin(REPO_ROOT, "docs", doc.source), "utf-8");
  return (
    frontMatterBlock({
      title: doc.title,
      canonical: `https://pharos.watch/docs/${doc.slug}/`,
      description: doc.summary,
    }) +
    body
  );
}

export function* iterateDocRoutes(): Generator<MarkdownRoute> {
  const { PUBLIC_DOCS } = require("../../shared/lib/public-docs");
  for (const doc of PUBLIC_DOCS) {
    yield { path: `/docs/${doc.slug}/`, body: renderDocMarkdown(doc) };
  }
}
```

- [ ] **Step 4: Wire into generator**

In `scripts/generate-markdown-exports.ts`, inside `main()` after digests:

```ts
for (const route of iterateDocRoutes()) {
  writeMarkdownRoute(OUT_DIR, route);
  count++;
}
```

- [ ] **Step 5: Run tests + build**

```bash
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
npm run build
ls out/docs/architecture/
```

Expected: PASS, build succeeds, `out/docs/architecture/index.md` exists alongside `index.html`.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-markdown-exports.ts scripts/lib/markdown-renderers.ts scripts/__tests__/generate-markdown-exports.test.ts
git commit -m "feat(md-gen): emit markdown variants for /docs routes"
```

## Task B.8: Sitemap + robots integration

**Goal:** `/docs/` and `/docs/<slug>/` appear in `sitemap.xml`. `robots.ts` already permits everything — no change needed.

**Files:**
- Modify: `src/app/sitemap.ts`.

- [ ] **Step 1: Write the failing test if any sitemap test exists**

```bash
ls src/app/*.test.* 2>/dev/null
find src -name "sitemap*.test*" 2>/dev/null
```

If a sitemap test exists, add an assertion. Otherwise skip — sitemap is validated by `npm run seo:check` after build.

- [ ] **Step 2: Implement**

In `src/app/sitemap.ts`, after the digest block and before the final `return`:

```ts
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import docsMetadata from "@/generated/docs-metadata.json";

const docsIndex: MetadataRoute.Sitemap = [
  {
    url: `${SITE_URL}/docs/`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  },
];

const docsPages: MetadataRoute.Sitemap = PUBLIC_DOCS.map((doc) => {
  const meta = (docsMetadata as Record<string, { dateModified: string }>)[doc.slug];
  return {
    url: `${SITE_URL}/docs/${doc.slug}/`,
    lastModified: meta ? new Date(meta.dateModified) : now,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  };
});

return [...staticPages, ...stablecoinPages, ...chainPages, ...pegPages, ...taxonomyPages, ...comparisonPages, ...digestPages, ...docsIndex, ...docsPages];
```

- [ ] **Step 3: Build**

```bash
npm run build
grep -c "docs/" out/sitemap.xml
```

Expected: grep returns at least 25 (index + 24 docs).

- [ ] **Step 4: Commit**

```bash
git add src/app/sitemap.ts
git commit -m "feat(sitemap): include /docs/* routes"
```

## Task B.9: llms.txt and about page integration

**Goal:** Link the docs archive from `public/llms.txt`, `src/app/about/page.tsx`, and `src/app/about/api/page.tsx`.

**Files:**
- Modify: `public/llms.txt` (created in Week 2).
- Modify: `src/app/about/page.tsx`.
- Modify: `src/app/about/api/page.tsx`.

- [ ] **Step 1: Confirm llms.txt exists**

```bash
test -f public/llms.txt && echo "present" || echo "missing"
```

If missing, the Week 2 deliverable wasn't shipped — **stop and escalate to the user** before continuing.

- [ ] **Step 2: Append Docs section to llms.txt**

Add to `public/llms.txt`:

```
## Docs

- [Documentation Archive](https://pharos.watch/docs/): Architectural, methodology, and design docs.
- [Architecture](https://pharos.watch/docs/architecture/)
- [API Reference](https://pharos.watch/docs/api-reference/)
- [Methodology - Report Cards](https://pharos.watch/docs/report-cards/)
- [Methodology - DEWS](https://pharos.watch/docs/dews/)
- [Methodology - Pricing Pipeline](https://pharos.watch/docs/pricing-pipeline/)

Docs support `Accept: text/markdown` content negotiation for agent consumption.
```

- [ ] **Step 3: Update about page**

In `src/app/about/page.tsx`, find a suitable place (typically near existing internal-link paragraphs) and add:

```tsx
<p>
  For architectural and methodology deep-dives, see the{" "}
  <Link href="/docs/" className="underline underline-offset-4 hover:text-foreground">
    documentation archive
  </Link>
  .
</p>
```

- [ ] **Step 4: Update about/api page**

In `src/app/about/api/page.tsx`, add a paragraph linking to `/docs/api-reference/` near the top-level intro.

- [ ] **Step 5: Commit**

```bash
git add public/llms.txt src/app/about/page.tsx src/app/about/api/page.tsx
git commit -m "feat(docs): surface docs archive in llms.txt and about pages"
```

## Task B.10: Verified doc links + doc counts CI checks

**Goal:** Run the existing project checks to confirm no regressions.

**Files:** none modified.

- [ ] **Step 1: Run CI scripts**

```bash
npm run check:verified-doc-links
npm run check:doc-source-paths
npm run check:doc-counts
```

Expected: all exit 0. If `check:verified-doc-links` flags a stale link inside one of the public docs, fix the doc.

- [ ] **Step 2: SEO static check after build**

```bash
npm run build && npm run seo:check
```

Expected: pass. If a warning fires about noindex or orphaned pages, investigate.

- [ ] **Step 3: Full merge gate**

```bash
npm run test:merge-gate
```

Expected: exit 0.

## Task B.11: Feature B PR

- [ ] **Step 1: Push branch, open PR with:**
  - Summary: 24 docs now public at `/docs/<slug>/`, served as HTML or markdown depending on Accept header.
  - Test plan:
    - `curl -s https://preview-url/docs/architecture/` — HTML
    - `curl -s -H "Accept: text/markdown" https://preview-url/docs/architecture/` — markdown
    - Visit `/docs/` in a browser — index lists 24 docs grouped into 3 sections
  - Rollback: revert the PR; the sitemap regenerates without `/docs/*`.

- [ ] **Step 2: Wait for CI green; squash merge.**

---

# Final Verification Checklist (after both PRs merge)

- [ ] `curl -sI -H "Accept: text/markdown" https://pharos.watch/methodology/` returns `text/markdown` + `Vary: Accept`
- [ ] `curl -sI -H "Accept: text/markdown" https://pharos.watch/stablecoin/usdt-tether/` returns `text/markdown` + `Vary: Accept`
- [ ] `curl -sI -H "Accept: text/markdown" https://pharos.watch/docs/architecture/` returns `text/markdown` + `Vary: Accept`
- [ ] `curl -sI https://pharos.watch/methodology/` returns `text/html` + `Vary: Accept`
- [ ] Browser load of `https://pharos.watch/docs/` lists 24 docs in 3 groups
- [ ] Browser load of `https://pharos.watch/docs/architecture/` shows Pharos chrome + rendered architecture doc
- [ ] `https://pharos.watch/sitemap.xml` contains `/docs/` and at least 24 `/docs/<slug>/` entries
- [ ] `https://pharos.watch/llms.txt` includes a `## Docs` section
- [ ] `npm run test:merge-gate` passes locally against the merged main
- [ ] `curl -s -H "Accept: text/markdown" -A "ChatGPT-User" https://pharos.watch/docs/architecture/` returns markdown (simulates a real AI crawler)

---

# Risks + Rollback

**Risk 1: Markdown output drifts from HTML.**
Mitigation: snapshot tests in Task A.11 catch unintentional changes to USDT, methodology index, changelog index. Methodology `CONTENT_MARKDOWN` constants are in the same file as the JSX — reviewers see both when editing. If a drift is intentional, refresh the fixture.

**Risk 2: Cloudflare Pages middleware hits CPU/size limits.**
Pages Functions free tier: 10 ms CPU, 100 MB memory, 25 MB response. Our middleware does an extra `env.ASSETS.fetch()` for markdown requests only — this adds <1 ms. Response size for the largest markdown variant (`docs/yield-intelligence.md`, 894 lines) is ~30 KB — well under 25 MB. No issue expected. If a limit fires, disable middleware by removing the file (rollback is a single commit).

**Risk 3: `Vary: Accept` fragments the CDN cache.**
Acknowledged in Architecture Decision #8. Doubling the cache entries for five route classes is acceptable. If cache hit rate collapses unexpectedly, the middleware change is reverted.

**Risk 4: Docs contain internal references (agents, audits, methodology branch names).**
Mitigation: the curated allowlist in `shared/lib/public-docs.ts` explicitly excludes `agent-*`, `*-page.md`, `runbooks/*`, and working notes. Each allowlisted doc was skimmed for `/agents/` and related internal references — any hits should be resolved before merge. If a post-merge review reveals an internal reference in a public doc, remove that doc from `PUBLIC_DOCS` (the build + sitemap auto-update on next deploy).

**Risk 5: `next-mdx-remote/rsc` does not emit under `output: "export"`.**
Task B.5 is the pre-scoped contingency: switch to a pure `remark → rehype → HTML` pipeline. ~30 minutes of work.

**Risk 6: The methodology section refactor (Task A.3) breaks existing tests.**
The refactor only **adds** a new export; existing JSX is untouched. If a test regression appears, it is a real bug in the extracted text — fix the constant, don't fix the test.

**Risk 7: `Accept` header parser incorrectly prefers markdown over HTML for regular browsers.**
Mitigation: the `prefersMarkdown` function in `functions/_middleware.ts` only returns `true` when markdown's q-value is ≥ HTML's. Chrome/Safari/Firefox all send `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8`, which has no `text/markdown` at all, so `prefersMarkdown` returns `false`. Manually verified by Task A.9 test case.

**Rollback plan (both features):**

- Feature A: delete `functions/_middleware.ts` + revert `prebuild` line in `package.json`. Cache entries with `Vary: Accept` will expire naturally (or purge via `wrangler cache purge`).
- Feature B: revert the Feature B PR. `PUBLIC_DOCS` is removed, sitemap regenerates, and `/docs/*` returns 404.

---

# Success Criteria

- 4+ route classes serve valid markdown on `Accept: text/markdown`: methodology (10 routes), stablecoin (191), changelog (1), digest (~6), docs (24). **Target: all 5.**
- 20+ docs publicly browseable at `/docs/<slug>/`. **Target: 24.**
- A dual curl test (AI crawler UA + markdown Accept) returns markdown, confirming the full agent access path works.

---

# Open Questions (surface to user before starting; do not guess)

1. **Breadcrumb depth (Task B.4):** confirm Week 1 actually shipped N-level `BreadcrumbJsonLd`. If not, ship the docs route with 2-level breadcrumb (mild degradation) or wait for Week 1 to complete.
2. **`public/llms.txt` presence (Task B.9):** confirm Week 2 shipped this file. If not, stop Feature B until it does.
3. **Allowlist curation edge cases:** should `*-page.md` route-contract docs be public? Default: exclude. If user wants them public, add to `PUBLIC_DOCS`.
4. **Footer / primary nav link to `/docs/`:** this plan routes `/docs/` via `about/` only. Flagging because adding a footer link is a design decision; default: no footer change until product says otherwise.
5. **`api-endpoint-authoring.md` is borderline operational.** Listed as system group but mostly useful for contributors. Default: include. User can strike if desired.
