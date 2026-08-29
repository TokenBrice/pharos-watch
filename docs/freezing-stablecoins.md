# Freezing a Tracked Stablecoin

Operator runbook for transitioning a tracked stablecoin into the `frozen` lifecycle phase. Frozen coins keep their detail page and historical data as a read-only archive but are excluded from every live aggregate, score recomputation, and write-side cron.

## When to freeze

Use the freeze procedure when a tracked stablecoin has effectively died — supply trending to zero, issuer abandonment, irrecoverable depeg, regulatory shutdown — and you want to preserve its historical data and detail page rather than erase it.

If the coin never launched on Pharos (no historical data), do not freeze: simply remove it.

## Pre-flight

1. Verify the coin is in `TRACKED_STABLECOINS` and currently `status: "active"` (or implicitly active — `status` omitted).
2. Confirm with the team that this is a freeze and not a temporary outage. Frozen is a one-way transition for v1.
3. Confirm you have a finalized obituary (cause of death, epitaph paragraph, source URL + label) before running the script.

## Procedure

### 1. Run the freeze script

```bash
PHAROS_API_KEY="$PHAROS_API_KEY" npx tsx scripts/maintenance/freeze-stablecoin.ts "$COIN_ID"
```

The script prints two artifacts:

- A new entry to append to `shared/data/stablecoins/frozen-snapshots.json`.
- A patch to apply to the coin's existing per-coin source file at `shared/data/stablecoins/coins/<id>.json`.

### 2. Apply the JSON edits

- Append the snapshot entry to `frozen-snapshots.json`.
- In the coin's per-coin source file (`shared/data/stablecoins/coins/<id>.json`), set `status: "frozen"`, add `frozenAt: "YYYY-MM-DD"`, and add the `obituary` block. Replace the placeholder strings (`causeOfDeath`, `epitaph`, `obituary`, `sourceUrl`, `sourceLabel`) with finalized copy.
- Keep the core tracked metadata fields intact (`id`, `name`, `symbol`, and `flags`). Frozen archive pages and cemetery exports still read the tracked metadata source; the freeze transition adds lifecycle fields rather than replacing the coin with a dead-stablecoin-only record.
- Run `npm run bootstrap:generated`, then `npm run check:generated-artifacts`, to refresh and verify the gitignored aggregate, report-card registry fingerprint, legacy redirect map, and client registry projections. Do not edit generated projections by hand.

The schema enforces the invariant: both `frozenAt` and `obituary` are required when `status === "frozen"`, and both fields are disallowed when `status` is anything else.

### 3. Remove from independent registries

Some worker subsystems maintain their own per-coin tables. Remove the frozen coin's entry from each:

- `worker/src/lib/mint-burn-contracts-data.ts` — remove from `MINT_BURN_CONFIG_SPECS` if present.
- `worker/src/lib/blacklist-contracts.ts` — remove from `CONTRACT_CONFIGS` if present.
- `shared/lib/bluechip-slugs.ts` — remove from `BLUECHIP_SLUG_MAP` if present.
- `worker/src/lib/yield-config/yield-config-pools.ts` — remove from `YIELD_POOL_MAP` if present; `yield-config.ts` derives/re-exports it.
- `src/lib/compare-pages.ts` — remove from `STATIC_COMPARE_PAIRS` if any pair includes the coin.
- Any per-coin sync cron (e.g. `sync-usds-status.ts`, `sync-kinesis-supply.ts`) — disable or remove.
- **`liveReservesConfig` block in the coin's own meta JSON.** If the frozen coin has a `liveReservesConfig` field on its `StablecoinMeta`, **delete that field**. Otherwise the live-reserves cron's `ACTIVE_STABLECOINS.filter(coin.liveReservesConfig)` would still include the coin once the registry filter widens (it is currently safe because `ACTIVE_STABLECOINS` excludes frozen, but removing the config eliminates ambiguity and matches the "no live data sources" intent of the freeze).

The CI guard in `npm run check:frozen-invariants` enforces the listed independent registry removals; `liveReservesConfig` and bespoke per-coin crons still require manual review.

### 3b. Add or verify the cemetery logo

`frozenToDeadShape()` uses the coin's canonical `data/logos.json` entry for frozen cemetery rows. Verify that entry points to an existing asset under `public/logos/` before freezing the coin.

```bash
rg '"<coin-id>"' data/logos.json
test -f "public/logos/<registered-logo-file>"
```

If no canonical tracked logo is registered, add one — or place the file where `frozenToDeadShape()`'s fallback resolves: `public/logos/<llamaId>-<symbol>.png` when the coin has a `llamaId`, and `public/logos/cemetery/<symbol>.png` only when it does not (the cemetery renderers prefix `/logos/cemetery/` solely for non-absolute paths). `frozenToDeadShape()` always resolves a non-empty logo path, and the tombstone renders it through `next/image` with no file-existence check — so a missing PNG shows a broken image, not a glyph. The `test -f` check above is load-bearing.

### 4. Validate

```bash
npm run bootstrap:generated
npm run check:stablecoin-data
npm run check:frozen-invariants
npm run lint
npm test -- --run
cd worker && npx tsc --noEmit && cd ..
npm run prebuild  # regenerates generated registries and the cemetery dataset
```

### 5. Update docs

- Add a changelog entry under `src/data/changelogs/` for the current week.
- Confirm the count of "tracked stablecoins" in `/about` and any docs is current. `/about` reads through `src/lib/stablecoin-static-data.ts`; `npm run bootstrap:generated` materializes its compile-input projection from the validated registry.
- **Per-domain methodology version constants are NOT bumped.** Frozen status is a lifecycle policy, not a scoring change. If the freeze is tied to a specific methodology revision (rare), bump that constant in a separate commit with its own changelog entry.

### 5b. Leave the AI summary alone

`data/ai-summaries.json` contains the editorial summary rendered on each detail page. **Do not regenerate** the frozen coin's summary — the model has no signal of the freeze beyond what we feed it, and rewriting risks losing nuance. The obituary lives in registry meta and renders via the `<FrozenStateBanner>` component independently of the AI summary. Do NOT run the `write-ai-summaries` skill on a frozen coin.

### 6. Commit

Commit/push according to current repo guidance. Open a PR only when explicitly requested; if a PR is requested, use title `feat(stablecoin): freeze <symbol> (<coin-id>)` and include a brief obituary in the PR body.

### 7. Post-deploy verification (within 24h)

- Visit `/cemetery/` — confirm the coin appears with a "View archived data →" link.
- Visit `/stablecoin/<id>/` — confirm the frozen banner below the hero (within the identity zone), and the "Data frozen on YYYY-MM-DD" footer above each chart section.
- Inspect Worker logs — confirm no INSERT/UPDATE for the coin's id from any cron.
- Confirm the next daily Telegram digest fires a **Newly Frozen Stablecoins** appendix section for the coin (`frozenDetected` in the digest appendix metadata). The cemetery appendix diffs `DEAD_STABLECOINS` only and stays silent on a freeze.
- Test OG: `https://api.pharos.watch/api/og/stablecoin/<id>` returns 200.

## Known behaviors (not bugs)

- **Pinned stablecoins drop the coin silently.** Users who pinned the coin lose it from their pinned list.
- **Live-comparison URL** `/compare/?coins=<id>,...` keeps the coin (its column header carries a `Frozen` badge tooltipped `Frozen on <date>`), but live metric cells fall back to the shared `—` placeholder tooltipped `No comparable data available`; no cell-level tooltip explains the freeze.
- **Rolling-window metrics** (24h flows, 7d depeg counts, etc.) gradually decay to zero or null past their window once ingestion stops.
- **No report card.** A frozen coin leaves `ACTIVE_STABLECOINS`, so the next V9 publication carries no card for it and the detail page renders without a grade. There is no all-F stub and no `isDefunct` flag — neither exists in the V9 card contract. This is an intentional v1 simplification; a future v2 could read the last-real card from D1 if richer history is wanted.
- **AI editorial summary preserved as-is.** The pre-freeze summary in `data/ai-summaries.json` continues to render on the detail page. We do not regenerate it on freeze — preserving the pre-freeze editorial framing.
- **Methodology versions unchanged.** Per-domain methodology version constants are NOT bumped on freeze. Frozen status is a lifecycle policy, not a scoring change; bump a methodology only when the freeze ships with a domain-specific scoring, ingestion, or API-contract change.
