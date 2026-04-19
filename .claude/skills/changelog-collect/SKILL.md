---
name: changelog-collect
description: Generate a weekly changelog entry from git history. Collects commits for a date range, filters noise, clusters by theme, writes an editorial summary, and outputs a ChangelogEntry file. Default behavior stops for review; pass --commit to also commit.
user_invocable: true
---

## Changelog Collection Skill

Generate a complete changelog entry for a given period. Default range is "since the previous published entry."

### Invocation

```
/changelog-collect                                   # from previous entry's `to` date → today
/changelog-collect 2026-03-17 2026-03-24             # explicit ISO range
/changelog-collect 2026-03-17 2026-03-24 --commit    # also commit (default prints for review)
/changelog-collect 2026-03-17 2026-03-24 --force     # allow overlap with an existing entry
```

### Where the output lands

- **File**: `src/data/changelogs/<YYYY-MM-DD>.ts` (the `to` date).
- **Barrel**: `src/data/changelogs/index.ts` (chronological imports + entry in `all`; the `.sort()` handles runtime order).
- **Rendered at**: `/changelog/` via `ChangelogEntryCard` inside a timeline `<ol>`. Each entry's `id` is `dateRange.to`, used by both the card's hash anchor and `ChangelogWeekNav`.
- **Displayed fields**: date range, "Latest" badge on the newest entry, `stats.totalCommits`, `headline`, summary list (label + tag + description + optional `href`), and a collapsed disclosure of the first 20 commits with an "and N more" tail.

### Workflow

#### 1. Resolve the date range

If two ISO dates are provided, use them as `from` and `to`.

Otherwise:
- List `src/data/changelogs/*.ts` (exclude `index.ts`, `types.ts`, `__tests__/`).
- Pick the newest by filename; read its `dateRange.to`.
- Set `from = previous_to + 1 day`, `to = today`.

**Overlap guard**: if the requested range intersects any existing entry's `[from, to]`, refuse unless `--force` is passed. Report which entry it overlaps.

#### 2. Collect commits

Use 8-char hashes (matches the card's `slice(0, 8)` display) and skip merges:

```bash
git log --no-merges --abbrev=8 --since="<from>" --until="<to> 23:59:59" --format="%h %s"
```

Keep the default newest-first ordering for `commits[]` — existing entries follow it.

#### 3. Strip operational noise

Drop commits matching any of these patterns from **both** `commits[]` and cluster analysis:

- `^chore(\([^)]+\))?: update hotspot ratchet baseline`
- `^chore(\([^)]+\))?: refresh hotspot ratchet`
- `^chore(\([^)]+\))?: satisfy hotspot ratchet`
- `^chore(\([^)]+\))?: update .* coverage baseline`
- `^(docs|Docs|Agent Docs) cleanup$`
- `^\[skip ci\]`
- `^Merge branch 'worktree-agent-`
- `^Merge pull request #\d+ from [^ ]+/dependabot/`
- `^chore\(deps(-dev)?\): bump`
- `^Revert "Revert "` → treat as a no-op pair; drop both the revert-of-revert and its original revert if both appear

If filtering removes >50% of the raw range, surface a note ("Filtered N noise commits — please sanity-check") in the review output.

Rationale: past entries (e.g. 2026-04-04 with 8× `Merge branch 'worktree-agent-…'` and 4× hotspot ratchet churn) bury real signal and skew the cluster heuristic.

#### 4. Cluster by theme

Group the surviving commits by conventional prefix (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`, `style`, `perf`) and scope. Look for natural themes:

- Coverage / data expansion (new stablecoins, reserve adapters, chain support)
- Pipeline / sync reliability (cron, `sync-*`, fetch hardening)
- Risk tooling / scoring (PSI, DEWS, Safety Score, Liquidity Score, blacklist)
- UI / UX improvements
- Infrastructure / CI / deploys
- Testing / quality
- Documentation
- Methodology version bumps

**Aim for 5–8 clusters.** Combine related work before adding filler; never split one story into two thin clusters to avoid hitting 9. A quiet 5-day cycle with one major shipping item is fine.

#### 5. Detect milestone facts

Actively check these signals — they often belong in the headline or a labeled cluster:

- **Stablecoin count crossings**: compare the count implied by `shared/data/stablecoins/*.json` (or the `npm run check:doc-counts` output) against the previous entry's claim. A crossing (e.g., 192 → 194) is headline-worthy.
- **Methodology version bumps**: grep filtered commits for `v\d+\.\d+\d?` (e.g., `v6.93`, `v5.0`). Map each bump to a cluster with the correct `href` (see step 7).
- **Live-reserve adapter additions**: `feat(reserves): add … adapter` / `promote … to live` / `enable live reserves for …`. Aggregate and cite the new total if material.
- **Audit / remediation series**: mentions of `audit`, `remediation`, `tranche`, `phase \d`. Usually a single "Codebase hardening" (`security`) cluster.
- **Auth / security milestones**: `auth`, `JWT`, `JWKS`, `api-keys`, `pepper`. Use `security` tag.
- **New data source integrations**: updates the about page too — flag so the reviewer can cross-check.

#### 6. Write the headline (≤ 120 chars)

**Template**: `[Big move 1], [big move 2], and [big move 3].`

Each "big move" is a concrete, user-facing shipping fact. Reference models:

- "Yield intelligence rebuilt from the ground up, API auth goes live, and a 100+ fix security audit lands."
- "Four new DEX APIs feed pricing consensus, Safety Score hits v6.0, and live reserves double to 114 coins."
- "Infrastructure axis launches, PSI hero gets arc gauge and event timeline, and Liquidity Score v5.0 brings size-aware scoring."

**Do**: name shipped features; cite a number when meaningful; end with a period.
**Don't**: open with "This week we…" / "Various improvements…" / "Multiple fixes across…"; don't write a purely infra headline unless infra genuinely is the story (a major migration, auth rollout, etc.).

#### 7. Write summary items

For each cluster, one `SummaryItem`:

- **`label`** (2–4 words, noun phrase): "Broader coverage", "Yield intelligence overhaul", "Stronger pipelines" — never "We broadened coverage".
- **`tag`** (always set explicitly — don't rely on the card's `inferTag()` fallback):
  - `feature` — new capabilities, scoring updates, integrations
  - `security` — auth, hardening, audit remediation
  - `coverage` — stablecoin additions, reserve expansion, data sources
  - `infra` — pipeline reliability, cron, sync, CI, status page
  - `design` — UI/UX polish, onboarding, motion, navigation
- **`description`** (≤ 220 chars, 1–3 sentences): user-facing impact, not a git log. Combine related commits into one sentence about the area, not a bulleted enumeration.
- **`href`** (set whenever a methodology is versioned or touched). Available routes under `src/app/methodology/`:
  - Safety Score → `/methodology/scoring-changelog/`
  - Yield → `/methodology/yield-changelog/`
  - Liquidity Score → `/methodology/liquidity-score-changelog/`
  - PegScore / DEWS / depeg → `/methodology/depeg-changelog/`
  - Pricing pipeline → `/methodology/pricing-pipeline-changelog/`
  - Stability Index (PSI) → `/methodology/stability-index-changelog/`
  - Mint/burn flows → `/methodology/mint-burn-flow-changelog/`
  - Blacklist tracker → `/methodology/blacklist-tracker-changelog/`
  - Chain Health → `/methodology/chain-health-changelog/`
  - General overview → `/methodology/`

#### 8. Build the commits list

Format the surviving commits as `CommitRef[]`:
- `hash`: 8-char abbreviation.
- `message`: full first line, unmodified.

Order: newest first (matches `git log` default and existing entries).

#### 9. Self-check before writing

Hard checks (must pass):
- `commits.length === stats.totalCommits` (the card renders `stats.totalCommits`; divergence misleads readers).
- Every `summary[i].tag` is one of the five enum values.
- Every `summary[i].description.length <= 220`.
- `headline.length <= 120`.
- `dateRange.from <= dateRange.to`.
- No existing changelog file overlaps the date range (re-verify after step 1 in case a parallel push landed).

Soft checks (warn, don't block):
- `summary.length` outside 5–8.
- A cluster touches a methodology but has no `href`.
- A coin count / adapter count / methodology version cited in the summary doesn't match the source of truth.

`stats.totalCommits` reflects the **filtered** count (after step 3). This is a deliberate break from older entries, which counted raw commits; do not try to match historical totals.

#### 10. Write the entry file

Path: `src/data/changelogs/<to>.ts` (e.g., `2026-04-24.ts`).

```ts
import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "<from>", to: "<to>" },
  headline: "<one-sentence thesis, ≤120 chars>",
  summary: [
    { label: "...", tag: "feature", description: "...", href: "/methodology/..." },
    // 5–8 items
  ],
  stats: { totalCommits: <N> },
  commits: [
    { hash: "<8-char>", message: "<first line>" },
    // exhaustive, after noise filter
  ],
};
```

#### 11. Update the barrel

Edit `src/data/changelogs/index.ts`:

- Insert the import in **chronological order** (existing convention — don't just append):
  ```ts
  import { entry as e<YYYYMMDD> } from "./<YYYY-MM-DD>";
  ```
- Insert `e<YYYYMMDD>` into the `all` array, also in chronological order.

The barrel's `.sort()` handles runtime ordering; the chronological layout exists for diff readability.

#### 12. Verify

Run the relevant gates locally:

```bash
npx tsc --noEmit                           # Catches bad tag enum, missing fields
npm run lint
npm test -- src/data/changelogs/           # Type + barrel tests
npm run check:doc-counts                   # Only if the summary cites a coin count
```

Cross-check any cited number (coin count, reserve adapter total, methodology version) against the source of truth.

Also confirm every `href` path exists under `src/app/methodology/` before declaring done.

#### 13. Present for review (default) or commit (--commit)

**Default** (no `--commit`): print to the user:
- Path of the new entry file
- Final `headline`
- Each summary `label` (+ `tag`)
- `stats.totalCommits`
- Any filter-warning notes from step 3
- Any soft-check warnings from step 9

Then stop. Wait for review.

**With `--commit`**: stage and commit only after all hard checks in step 9 pass:

```bash
git add src/data/changelogs/<to>.ts src/data/changelogs/index.ts
git commit -m "docs(changelog): add changelog for <from> to <to>"
```

Per CLAUDE.md, run `npm run test:merge-gate` before any push.

### Quality guidelines

- Summary bullets read like a product update, not a git log. User-facing impact first.
- Prefer combining over enumeration: "Telegram delivery hardened (rate-limit handling, HTML repair, retry cap)" beats listing each fix.
- Labels are noun phrases, parallel in structure.
- Headlines name shipped features with concrete numbers when available.
- `commits[]` is exhaustive after noise filtering — every surviving commit appears.

### Future enrichment opportunities

Not implemented yet — documented here so future sessions can pick them up without re-deriving the design:

- **Diffstat in `stats`**: extending `ChangelogEntry.stats` with `filesChanged?: number; linesAdded?: number; linesRemoved?: number;` (via `git log --shortstat --no-merges --since=… --until=…`, summed) gives the card a denser at-a-glance metric than commit count alone. Requires adding the fields to `src/data/changelogs/types.ts` and rendering them in `ChangelogEntryCard`.
- **PR-ref hyperlinks in the commit list**: commit messages already contain `(#NN)` in plain text. A small `String.prototype.replace` in the commit `<li>` of `ChangelogEntryCard` can turn them into links to `https://github.com/TokenBrice/stablecoin-dashboard/pull/NN`.
- **Per-entry stats delta**: surface "+N stablecoins", "+N live-reserve adapters" automatically by comparing the previous entry's computed counts. Would require either a small metadata block per entry or an on-render computation against the tracked-coins data set.
