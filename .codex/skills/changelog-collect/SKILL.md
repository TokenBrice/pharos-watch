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

Extended reference (edge cases, history, examples): read ./reference.md when needed.

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

- `^(chore(\([^)]+\))?|docs): (refresh|regenerate) ` — the dominant noise class: generated-artifact and metadata refresh commits (docs metadata, agent code map, cemetery/release datasets, liquidity metadata, doc artifacts)
- `^chore\(v9\): refresh CDP shock-coverage measurements` — the auto-merging scheduled refresh PR lands one of these roughly every other day
- `^Refresh (audit task index|documentation|docs)\b`
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

The two `^Merge …` patterns are normally unreachable under `--no-merges` (step 2); they are kept only as a guard for commit lists collected without that flag.

This pattern list drifts as repo automation changes. Before filtering, scan the raw range for high-frequency refresh/regenerate-shaped subjects (`git log --no-merges --since=… --until=… --format="%s" | sort | uniq -c | sort -rn | head`); treat any new dominant generated-artifact subject as noise even if unlisted, note it in the review output, and extend this list.

If filtering removes >50% of the raw range, surface a note ("Filtered N noise commits — please sanity-check") in the review output.

#### 4. Cluster by theme

Group the surviving commits by conventional prefix (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`, `style`, `perf`) and scope.

**Aim for 5–8 clusters.** Combine related work before adding filler; never split one story into two thin clusters to avoid hitting 9. A quiet 5-day cycle with one major shipping item is fine.

#### 5. Detect milestone facts

Actively check these signals — they often belong in the headline or a labeled cluster:

- **Stablecoin count crossings**: compare the count in `shared/data/stablecoins/coins.generated.json` against the previous entry's claim. A crossing (e.g., 192 → 194) is headline-worthy.
- **Methodology version bumps**: grep filtered commits for `v\d+\.\d+\d?` (e.g., `v6.93`, `v5.0`). Map each bump to a cluster with the correct `href` (see step 7).
- **New data source integrations**: updates the about page too — flag so the reviewer can cross-check.

#### 6. Write the headline (≤ 120 chars)

**Template**: `[Big move 1], [big move 2], and [big move 3].`

Each "big move" is a concrete, user-facing shipping fact.

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
- **`href`** (set whenever a methodology is versioned or touched).

#### 8. Write Field Notes

Populate `fieldNotes` for every new entry. This is the recurring Editor's note
slot rendered above the structural summary list, so treat it as part of the
changelog contract rather than optional decoration. (The field is `optional`
in `src/data/changelogs/types.ts`; it is required by editorial policy — do
not "fix" this skill against the type.)

Requirements:
- 45-80 words.
- One paragraph.
- Editorial synthesis of what the week meant, not a commit summary.
- No bullets, commit hashes, Markdown, or "this release refactored..." phrasing.
- Modest claims when the evidence is mostly maintenance or validation work.

Use `headline` for the compact thesis, `fieldNotes` for the human framing, and
`summary[]` for the commit-derived facts.

#### 9. Build the commits list

Format the surviving commits as `CommitRef[]`:
- `hash`: 8-char abbreviation.
- `message`: full first line, unmodified.

Order: newest first (matches `git log` default and existing entries).

#### 10. Self-check before writing

Hard checks (must pass):
- `commits.length === stats.totalCommits` (the card renders `stats.totalCommits`; divergence misleads readers).
- Every `summary[i].tag` is one of the five enum values.
- Every `summary[i].description.length <= 220`.
- `headline.length <= 120`.
- `fieldNotes` is present and 45-80 words.
- `dateRange.from <= dateRange.to`.
- No existing changelog file overlaps the date range (re-verify after step 1 in case a parallel push landed).

Soft checks (warn, don't block):
- `summary.length` outside 5–8.
- A cluster touches a methodology but has no `href`.
- A coin count / adapter count / methodology version cited in the summary doesn't match the source of truth.

`stats.totalCommits` reflects the **filtered** count (after step 3); every published entry satisfies `commits.length === stats.totalCommits`.

#### 11. Write the entry file

Path: `src/data/changelogs/<to>.ts` (e.g., `2026-04-24.ts`).

```ts
import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "<from>", to: "<to>" },
  headline: "<one-sentence thesis, ≤120 chars>",
  fieldNotes: "<45-80 word editor's note>",
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

#### 12. Update the barrel

Edit `src/data/changelogs/index.ts`:

- Insert the import in **chronological order** (existing convention — don't just append):
  ```ts
  import { entry as e<YYYYMMDD> } from "./<YYYY-MM-DD>";
  ```
- Insert `e<YYYYMMDD>` into the `all` array, also in chronological order.

The barrel's `.sort()` handles runtime ordering; the chronological layout exists for diff readability.

#### 13. Verify

Run the relevant gates locally:

```bash
npm run typecheck                          # Catches bad tag enum, missing fields
npm run lint
npm test -- src/data/changelogs/           # Type + barrel tests
npm run check:stablecoin-data              # If the summary cites a coin count
```

Cross-check any cited number (coin count, reserve adapter total, methodology version) against the source of truth.

Also confirm every `href` path exists under `src/app/methodology/` before declaring done.

#### 14. Present for review (default) or commit (--commit)

**Default** (no `--commit`): print to the user:
- Path of the new entry file
- Final `headline`
- `fieldNotes`
- Each summary `label` (+ `tag`)
- `stats.totalCommits`
- Any filter-warning notes from step 3
- Any soft-check warnings from step 10

Then stop. Wait for review.

**With `--commit`**: stage and commit only after all hard checks in step 10 pass:

```bash
git add src/data/changelogs/<to>.ts src/data/changelogs/index.ts
git commit -m "docs(changelog): add changelog for <from> to <to>"
```

Before publishing, run the focused changelog checks above. Use `pharos-release-runner` for the protected branch/PR path; GitHub's required `PR gate` is authoritative, and the heavy local merge gate is an explicit rehearsal only.
