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
PHAROS_API_KEY=<key> npx tsx scripts/freeze-stablecoin.ts <coin-id>
```

The script prints two artifacts:

- A new entry to append to `shared/data/stablecoins/frozen-snapshots.json`.
- A patch to apply to the coin's existing entry in its source JSON file under `shared/data/stablecoins/`.

### 2. Apply the JSON edits

- Append the snapshot entry to `frozen-snapshots.json`.
- In the coin's source file (`shared/data/stablecoins/usd-major.json`, `shared/data/stablecoins/coins/<id>.json`, or wherever it lives), set `status: "frozen"`, add `frozenAt: "YYYY-MM-DD"`, and add the `obituary` block. Replace the placeholder strings (`causeOfDeath`, `epitaph`, `obituary`, `sourceUrl`, `sourceLabel`) with finalized copy.

The schema enforces the invariant: `frozenAt` is required when `status === "frozen"`, and `obituary` is only allowed when `status === "frozen"`.

### 3. Remove from independent registries

Some worker subsystems maintain their own per-coin tables. Remove the frozen coin's entry from each:

- `worker/src/lib/mint-burn-contracts-data.ts` — remove from `MINT_BURN_CONFIG_SPECS` if present.
- `worker/src/lib/blacklist-contracts.ts` — remove from `CONTRACT_CONFIGS` if present.
- `worker/src/lib/bluechip-slugs.ts` — remove from `BLUECHIP_SLUG_MAP` if present.
- `worker/src/cron/yield-history-backfill.ts` — remove from `YIELD_POOL_MAP` if present.
- `src/lib/compare-pages.ts` — remove from `STATIC_COMPARE_PAIRS` if any pair includes the coin.
- Any per-coin sync cron (e.g. `sync-usds-status.ts`, `sync-kinesis-supply.ts`) — disable or remove.

The CI guards in `npm run check:frozen-invariants` enforce that frozen coins do not appear in any of the above.

### 4. Validate

```bash
npm run check:frozen-invariants
npm run lint
npm test -- --run
cd worker && npx tsc --noEmit && cd ..
npm run prebuild  # regenerates the cemetery dataset
```

### 5. Update docs

- Add a changelog entry under `src/data/changelogs/` for the current week.
- Confirm the count of "tracked stablecoins" in `/about` and any docs is current. The `/about` page reads `ACTIVE_STABLECOINS.length` directly, so the count auto-shifts.
- **Per-domain methodology version constants are NOT bumped.** Frozen status is a lifecycle policy, not a scoring change. If the freeze is tied to a specific methodology revision (rare), bump that constant in a separate commit with its own changelog entry.

### 5b. Leave the AI summary alone

`data/ai-summaries.json` contains the editorial summary rendered on each detail page. **Do not regenerate** the frozen coin's summary — the model has no signal of the freeze beyond what we feed it, and rewriting risks losing nuance. The obituary lives in registry meta and renders via the `<FrozenStateBanner>` component independently of the AI summary. Do NOT run the `write-ai-summaries` skill on a frozen coin.

### 6. Open PR

PR title: `feat(stablecoin): freeze <symbol> (<coin-id>)`. Include a brief obituary in the PR body.

### 7. Post-deploy verification (within 24h)

- Visit `/cemetery/` — confirm the coin appears with a "View archived data →" link.
- Visit `/stablecoin/<id>/` — confirm the frozen banner above the hero, and the "Data frozen on YYYY-MM-DD" footer above each chart section.
- Inspect Worker logs — confirm no INSERT/UPDATE for the coin's id from any cron.
- Confirm the next daily Telegram digest fires a cemetery appendix line.
- Test OG: `https://api.pharos.watch/api/og?stablecoin=<id>` returns 200.

## Known behaviors (not bugs)

- **Pinned stablecoins drop the coin silently.** Users who pinned the coin lose it from their pinned list.
- **Live-comparison URL** `/compare/?coins=<id>,...` keeps the coin (badged as frozen), but live metric cells render `—` with a tooltip explaining the freeze.
- **Rolling-window metrics** (24h flows, 7d depeg counts, etc.) gradually decay to zero or null past their window once ingestion stops.
- **Stub F-card.** The report card for a frozen coin shows an all-F stub (`isDefunct: true`) matching the existing `DEAD_STABLECOINS` defunct-card pattern, rather than the coin's last-real grade. This is an intentional v1 simplification (decision F2=a in the plan); a future v2 could read the last-real card from D1 if richer history is wanted.
- **AI editorial summary preserved as-is.** The pre-freeze summary in `data/ai-summaries.json` continues to render on the detail page. We do not regenerate it on freeze — preserving the pre-freeze editorial framing.
- **Methodology versions unchanged.** Per-domain methodology version constants (Safety Scores 7.14, Liquidity 5.5, Depeg/DEWS 5.95, PSI 3.2, Yield 7.43, Mint/Burn 6.0, Pricing 5.0, Blacklist 3.99, Redemption Backstop 3.992, Chain Health 1.2) are NOT bumped on freeze. Frozen status is a lifecycle policy, not a scoring change.
