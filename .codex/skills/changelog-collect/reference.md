## Changelog Collection — Extended Reference

Material moved verbatim from `SKILL.md`: render-context notes, theme/signal catalogs, headline models, href route map, quality guidelines, and future ideas.

### Where the output lands

- **File**: `src/data/changelogs/<YYYY-MM-DD>.ts` (the `to` date).
- **Barrel**: `src/data/changelogs/index.ts` (chronological imports + entry in `all`; the `.sort()` handles runtime order).
- **Rendered at**: `/changelog/` via `ChangelogEntryCard` inside a timeline `<ol>`. Each entry's `id` is `dateRange.to`, used by both the card's hash anchor and `ChangelogWeekNav`.
- **Displayed fields**: date range, "Latest" badge on the newest entry, `stats.totalCommits`, `headline`, `fieldNotes` editor note, summary list (label + tag + description + optional `href`), and a collapsed disclosure of the first 20 commits with an "and N more" tail.

### Noise filter — rationale

Rationale: past entries (e.g. 2026-04-04 with 8× `Merge branch 'worktree-agent-…'` and 4× hotspot ratchet churn) bury real signal and skew the cluster heuristic.

### Cluster themes

Look for natural themes:

- Coverage / data expansion (new stablecoins, reserve adapters, chain support)
- Pipeline / sync reliability (cron, `sync-*`, fetch hardening)
- Risk tooling / scoring (PSI, DEWS, Safety Score, Liquidity Score, blacklist)
- UI / UX improvements
- Infrastructure / CI / deploys
- Testing / quality
- Documentation
- Methodology version bumps

### Milestone signals — additional patterns

- **Live-reserve adapter additions**: `feat(reserves): add … adapter` / `promote … to live` / `enable live reserves for …`. Aggregate and cite the new total if material.
- **Audit / remediation series**: mentions of `audit`, `remediation`, `tranche`, `phase \d`. Usually a single "Codebase hardening" (`security`) cluster.
- **Auth / security milestones**: `auth`, `JWT`, `JWKS`, `api-keys`, `pepper`. Use `security` tag.

### Headline reference models

Reference models:

- "Yield intelligence rebuilt from the ground up, API auth goes live, and a 100+ fix security audit lands."
- "Four new DEX APIs feed pricing consensus, Safety Score hits v6.0, and live reserves double to 114 coins."
- "Infrastructure axis launches, PSI hero gets arc gauge and event timeline, and Liquidity Score v5.0 brings size-aware scoring."

### Methodology href routes

Available routes under `src/app/methodology/`:

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

### Quality guidelines

- Summary bullets read like a product update, not a git log. User-facing impact first.
- Field Notes reads like a short editor's note: interpretive, specific, and grounded in the shipped work.
- Prefer combining over enumeration: "Telegram delivery hardened (rate-limit handling, HTML repair, retry cap)" beats listing each fix.
- Labels are noun phrases, parallel in structure.
- Headlines name shipped features with concrete numbers when available.
- `commits[]` is exhaustive after noise filtering — every surviving commit appears.

### Future enrichment opportunities

Not implemented yet — documented here so future sessions can pick them up without re-deriving the design:

- **Diffstat in `stats`**: extending `ChangelogEntry.stats` with `filesChanged?: number; linesAdded?: number; linesRemoved?: number;` (via `git log --shortstat --no-merges --since=… --until=…`, summed) gives the card a denser at-a-glance metric than commit count alone. Requires adding the fields to `src/data/changelogs/types.ts` and rendering them in `ChangelogEntryCard`.
- **PR-ref hyperlinks in the commit list**: commit messages already contain `(#NN)` in plain text. A small `String.prototype.replace` in the commit `<li>` of `ChangelogEntryCard` can turn them into links to `https://github.com/TokenBrice/pharos-watch/pull/NN`.
- **Per-entry stats delta**: surface "+N stablecoins", "+N live-reserve adapters" automatically by comparing the previous entry's computed counts. Would require either a small metadata block per entry or an on-render computation against the tracked-coins data set.
