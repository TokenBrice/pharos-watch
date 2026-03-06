---
title: "Generate Cloudflare Pages _redirects for old stablecoin URLs"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Create a build-time script that generates a `_redirects` file mapping old stablecoin URLs to their canonical equivalents, preserving SEO link equity.

## Task

### 1. Create `scripts/generate-redirects.ts`

```ts
/**
 * Generates Cloudflare Pages _redirects entries for the stablecoin ID migration.
 * Reads existing _redirects, appends migration redirects (idempotent).
 *
 * Usage: npx tsx scripts/generate-redirects.ts
 */
```

### 2. Mapping source

**Use Option A (hardcoded mapping).** Copy the `ID_MAPPING`, `SHADOW_ID_MAPPING`, and `DEAD_ID_MAPPING` arrays from `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator) directly into the script as a const array. This makes the script self-contained with no import path issues. Since old IDs are frozen (they never change), there is no sync concern.

The mapping covers:
- 148 tracked stablecoins (numeric, cg-*, gold-*, silver-* → ticker-issuer)
- 2 shadow stablecoins ("3" → "ust-terra", "iron-finance" → "iron-iron-finance")
- ~21 dead stablecoins with numeric oldIds that had live `/stablecoin/<id>/` pages

**Exclude dead-* prefixed entries** (~57 entries with oldIds like `"dead-usnbt-1"`): These IDs have never existed as live URLs — no page at `/stablecoin/dead-usnbt-1/` was ever served. Generating redirects for them is pointless since there are no inbound links to preserve and dead stablecoins don't have detail pages.

**Collision on oldId `"3"`:** This appears in both `SHADOW_ID_MAPPING` (→ `"ust-terra"`) and `DEAD_ID_MAPPING` (→ `"ust-terra-classic"`). **Shadow takes precedence** — `/stablecoin/3/` was UST's live page. Deduplicate by processing `ID_MAPPING` first, then `SHADOW_ID_MAPPING`, then `DEAD_ID_MAPPING` (skip entries whose oldId is already mapped).

Total: ~171 redirect rules (148 tracked + 2 shadow + ~21 numeric dead).

### 3. Redirect format

For each `{ oldId, newId }` entry, output:
```
/stablecoin/<oldId>/ /stablecoin/<newId>/ 301
/stablecoin/<oldId> /stablecoin/<newId>/ 301
```

Two lines per entry (with and without trailing slash) to catch both URL patterns and avoid double-redirects (CF Pages auto-redirects non-trailing-slash to trailing-slash, but having both lines catches them directly).

Cloudflare Pages has a **2000 static redirect rule limit** (we'll use ~342 lines for ~171 entries — well within limits).

### 4. Integration with existing `public/_redirects`

The existing `public/_redirects` has 8 redirect rules (report-cards, risk-lab, peg-tracker, stability-index-alt). The script must NOT overwrite these.

**Implementation:**
1. Read `public/_redirects`
2. Look for the comment separator `# Stablecoin ID migration redirects`
3. If found, replace everything from that line onward (idempotent on re-run)
4. If not found, append after existing content
5. Write the combined result back to `public/_redirects`

```ts
const SEPARATOR = "# Stablecoin ID migration redirects (auto-generated)";

const existing = fs.readFileSync("public/_redirects", "utf-8");
const sepIdx = existing.indexOf(SEPARATOR);
const base = sepIdx >= 0 ? existing.substring(0, sepIdx).trimEnd() : existing.trimEnd();
const output = base + "\n\n" + SEPARATOR + "\n" + redirectLines.join("\n") + "\n";
fs.writeFileSync("public/_redirects", output);
```

### 5. Build integration

Add to `package.json` scripts:
```json
"prebuild": "npx tsx scripts/generate-redirects.ts"
```

If a `prebuild` script already exists, append this command with `&&`.

### 6. URL encoding

For IDs with special characters, use `encodeURIComponent()` on both old and new IDs in the redirect paths. Most IDs only contain alphanumerics and hyphens (no encoding needed), but handle edge cases safely.

## Acceptance Criteria

- `npx tsx scripts/generate-redirects.ts` exits 0
- `public/_redirects` exists after running and still contains the original 8 redirect rules at the top
- `grep -c '301$' public/_redirects` returns at least 340 (8 existing + ~330+ migration)
- `grep '/stablecoin/1/ /stablecoin/usdt-tether/ 301' public/_redirects` returns 1 match
- `grep '/stablecoin/cg-ustb/ /stablecoin/ustb-superstate/ 301' public/_redirects` returns 1 match (or equivalent canonical ID)
- `npm run build` exits 0 (prebuild runs the script automatically)
- Running `npx tsx scripts/generate-redirects.ts` twice produces identical output (idempotent)
