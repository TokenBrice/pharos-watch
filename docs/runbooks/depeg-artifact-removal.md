# Depeg Artifact-Event Removal

Owner runbook for removing reviewed price-feed artifacts from the public depeg
history and keeping the removal durable. The feature and methodology contract
lives in [`docs/depeg-detection.md`](../depeg-detection.md) (Historical Backfill
Validation); this file owns the operator sequence.

## Why this exists

The live detector and the hourly backfill replay both read the same price
series, so a last-trade print that no economic trade supports can open a stored
depeg row. Deleting the row alone is not durable: the next admin replay deletes
and recomputes every `source='backfill'` row in that coin's window, and the
CoinGecko audit cannot help — a CoinGecko-sourced artifact reproduces in
CoinGecko's own history, so the audit reads it as `confirmed` by construction.
Two mechanisms keep a reviewed removal in place: the
[replay-suppression registry](#recording-the-verdict) and the generic
live-overlap dedupe.

## Preconditions

- The artifact verdict is reviewed against primary evidence: no economic-size
  on-chain trade at the stored deviation, and pool mids at peg through the
  window. Keep the transaction and price-feed links for the registry entry.
- The suppression registry and the live-overlap skip are **deployed** before the
  delete. A delete that lands first can be undone by the next window replay.
- No candidate event is linked to a sealed DDRv2 prediction. A sealed id is
  reported as a conflict and must go through the append-only repair path instead
  of a direct delete.

## Removal sequence

Run the commands below from the repository root with Wrangler authentication. Historical repairs are no longer browser actions; see [one-shot backfills](./one-shot-backfills.md).

1. **Preview (read-only).**

   ```bash
   npx tsx worker/scripts/one-shot-backfill.ts audit-depeg-history --query 'dry-run=true&symbol=USN' | jq
   ```

   Check `totalMatching` and each `auditedEvents[*].verdict`. Read stored
   provenance and canonical coin identity separately from D1
   `depeg_events_with_provenance` by event id; the preview omits both.
   `upstreamErrorReason: "coingecko_api_key_missing"` with
   `upstreamReachable: false` means the CLI's `COINGECKO_API_KEY` process
   environment variable is unset. Fix it before trusting CoinGecko verdicts
   (delete and repair modes do not need the key).

2. **Record the verdict.** Add the reviewed window to
   `shared/data/depegs/backfill-replay-suppressions.ts` (see
   [Recording the verdict](#recording-the-verdict)) and run the integrity suite
   before deleting anything.

3. **Delete.** The `delete` mode skips the CoinGecko audit and stages the PSI
   stability-index recompute with the deletes in one D1 batch commit:

   Delete ids are global, not constrained by the preview's `symbol` filter.
   First preview `delete=49235,49236,49237,24424,83782&dry-run=true` with the
   same CLI, then compare the complete requested id set with `deletedEvents`;
   a partial match can succeed. Verify coin identity from D1 before execution.

   ```bash
   npx tsx worker/scripts/one-shot-backfill.ts audit-depeg-history --query 'delete=49235,49236,49237,24424,83782' --execute --allow-atomic-import | jq
   ```

   Schedule a maintenance window: the atomic import can briefly make D1 unavailable
   to the live Worker. A confirmed completed command's `deletedEvents` lists removed
   rows and `daysRecomputed` the PSI days repaired. `409` (`DDRv2 sealed repair
   required`) lists sealed conflicts and the run must stop for those ids. `500`
   or interruption requires reconciliation; do not infer rollback from a missing
   response. Follow [receipt cleanup](./one-shot-backfills.md#interruption-and-cleanup)
   before explicitly resuming; there is no HTTP replay reservation.

4. **Retire the archive.** The `/depeg/<slug>/` pages for the removed rows
   disappear only through the reviewed shrink override:

   ```bash
   npx tsx scripts/maintenance/sync-depeg-events.ts --api-url https://api.pharos.watch --allow-archive-shrink
   ```

   Set `DEPEG_EVENTS_API_KEY` (or `SMOKE_API_KEY`) for this HTTP fetch;
   Wrangler authentication alone does not authenticate it. Add one-hop 301s
   in `public/_redirects` for every retired published slug before the Pages
   build. The Pages release gate configures `SEO_PREVIOUS_SITEMAP_URL` to
   enforce continuity; local `npm run seo:check` compares prior URLs only
   when that variable is set. Existing USN redirects live in `public/_redirects`.

5. **Verify.** Re-read the coin's history
   (`GET https://api.pharos.watch/api/depeg-events?stablecoin=usn-noon` with a
   public API key) and confirm the rows are gone. Then confirm the next window
   replay does not recreate them: the replay logs
   `backfill-depegs-episode-skipped` with `skipReason: reviewed-suppression` or
   `skipReason: live-overlap` for each dropped episode.

## Recording the verdict

Entries live in `shared/data/depegs/backfill-replay-suppressions.ts`:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `coinId` | `string` | Tracked stablecoin id, validated against the canonical order |
| `direction` | `"above" \| "below"` | Depeg side the verdict applies to |
| `windowStart` / `windowEnd` | `number` | Inclusive UTC bounds in Unix seconds |
| `reason` | `string` | The artifact conclusion |
| `evidenceUrls` | `string[]` | On-chain transaction and price-feed links (`https` only) |
| `reviewedAt` | `string` | Review date, `YYYY-MM-DD` |

Set the window to the union of the stored episode and its dust/recovery
transactions plus a ±2h margin: hourly CoinGecko samples can move an episode
edge by up to an hour, and matching is inclusive interval overlap on
`(coinId, direction)`.

The corpus validates at import time, and

```bash
npx vitest run shared/data/depegs/__tests__/backfill-replay-suppressions.test.ts
```

guards tracked coin ids, the shared direction vocabulary, ordered integer
windows, `https` evidence URLs, review dates, and non-overlapping
same-coin/same-direction windows. A window overlapping an existing entry on the
same coin and direction is rejected by design — extend the existing window
instead of adding a second one.

## Related

- Live-overlap dedupe (sibling mechanism, no registry entry needed): a
  recomputed backfill episode is skipped when an existing live row of the same
  coin and direction overlaps it.
- [`docs/runbooks/depeg-lifecycle-review.md`](./depeg-lifecycle-review.md) —
  open-event lifecycle flags and wind-down curation.
- [`docs/depeg-detection.md`](../depeg-detection.md) — backfill replay
  semantics, the registry contract, and the archive/redirect continuity rule.
