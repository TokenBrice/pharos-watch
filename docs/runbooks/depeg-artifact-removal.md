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
- No candidate event is an unsealed DDR incident member. Incident event links
  are append-only, so deleting a member leaves a dangling reference that fails
  `/api/depeg-events` closed. Delete, split repair and backfill replay refuse
  these ids (`DDR incident member ... refused`); no supported path retires an
  unsealed incident, so leave the event in place.

## Sealed-event input corruption (retain history)

When original observations prove input corruption but an economic episode is
real, do **not** delete the event, fabricate a replacement peak, or add a replay
suppression. Use `worker/scripts/record-depeg-input-corruption.ts` to append an
`input_corruption` erratum and quarantine the event with audit verdict `disputed`.
The raw event, assessments, sealed prediction bytes/hash, incident membership,
and first-publication archive stay unchanged. Existing provenance fields are
retained; only its verdict, public JSON verdict, and update clock change.

1. Review the evidence and exact event/coin/prediction/incident identities.
   Keep the nonempty reviewed evidence file in the durable repair packet.
   `--reviewed-evidence` and `--reviewed-by` attest operator review; the tool
   records its absolute path and SHA-256, not an automated economic verdict.
   Keep those exact bytes with the command output, including the pre-repair
   provenance recorded in `admin_action_audit`.
2. Preview from the repository root:

   ```bash
   npx tsx worker/scripts/record-depeg-input-corruption.ts \
     --event-id <event-id> --prediction-id <sealed-prediction-id> \
     --stablecoin-id <canonical-coin-id> --incident-key <incident-key> \
     --reviewed-evidence <reviewed-file> --reviewed-by <reviewer> \
     --note '<source-bound corruption finding; known replacement limits>'
   ```

   Default is an **offline DRY-RUN**, even with `--remote`: it prints the exact
   guarded SQL statements, evidence hash, expiry, and readback query without
   contacting D1. Live guards are evaluated only on apply. The plan expires
   after 15 minutes; a later invocation generates fresh timestamps.
3. Before applying, retain a fresh D1 Time Travel bookmark and schedule the
   atomic-import maintenance window described in
   [one-shot backfills](./one-shot-backfills.md). Recheck evidence and identity,
   then run the same command with **both** `--apply --remote`. No local apply
   mode exists. It makes one unchunked atomic D1 import: guarded audit,
   erratum, erratum-linked `provenance_invalidation` authorization,
   consumption, disputed provenance, and final guard. Existing schema triggers
   append the single-use authorization-use record. No migration is required.

   Guards refuse a missing/open/wrong-coin event, mismatched prediction or
   incident, multiple linked sealed predictions, any prior prediction erratum,
   an already ineligible verdict in either provenance representation,
   malformed/non-object public provenance JSON, an unexpired unused repair
   grant, or an expired plan. These are reconciliation stops, not reasons to
   bypass a trigger. SQL guard failure rolls back the whole import.
4. Retain the successful readback: exactly one erratum, its authorization,
   consumption and trigger-written use; `audit_verdict` and public
   `auditVerdict` both `disputed`; sealed `row_hash` equals `row_hash_before`.
   The import receipt can contain Wrangler progress lines even with `--json`;
   the CLI extracts its JSON envelope, then performs a separate `--json` SELECT
   and prints the erratum, prediction, authorization, consumption/use clocks and
   unchanged sealed hash. A receipt-parsing error after import does **not** mean
   rollback: reconcile the printed readback query before considering a retry.
   Re-read raw event and sealed prediction against the reviewed pre-repair
   packet. The resolver exposes the original prediction with its invalidation
   overlay after its normal publication refresh. Current PegScore excludes
   disputed provenance on the next admitted producer recomputation; existing
   cached publications are not rewritten by this command. Confirm excluded
   event readback and the recomputed peg multiplier without assuming perfect peg.

If execution is interrupted or reports an error, reconcile the append-only
ledgers and provenance before any retry. A committed repair deliberately refuses
to run twice; never remove errata or authorizations to make it runnable again.

## Removal sequence

Run the commands below from the repository root with Wrangler authentication. Historical repairs are no longer browser actions; see [one-shot backfills](./one-shot-backfills.md).

1. **Preview (read-only).**

   ```bash
   npx tsx worker/scripts/one-shot-backfill.ts audit-depeg-history --query 'dry-run=true&symbol=<symbol>' | jq
   ```

   Check `totalMatching` and each `auditedEvents[*].verdict`. Read stored
   provenance and canonical coin identity separately from D1
   `depeg_events_with_provenance` by event id; the preview omits both.
   `upstreamErrorReason: "coingecko_api_key_missing"` with
   `upstreamReachable: false` means the CLI's `COINGECKO_API_KEY` process
   environment variable is unset. Fix it before trusting CoinGecko verdicts
   (delete and repair modes do not need the key).

   The reviewed USN case used `usn-noon` and ids
   `49235,49236,49237,24424,83782`; its evidence windows remain in the registry.
   Select the current case's complete reviewed id set, not that example set.

2. **Record the verdict.** Add the reviewed window to
   `shared/data/depegs/backfill-replay-suppressions.ts` (see
   [Recording the verdict](#recording-the-verdict)) and run the integrity suite
   before deleting anything.

3. **Delete.** The `delete` mode skips the CoinGecko audit and stages the PSI
   stability-index recompute with the deletes in one D1 batch commit:

   Delete ids are global, not constrained by the preview's `symbol` filter.
   First preview `delete=<reviewed-ids>&dry-run=true` with the
   same CLI, then compare the complete requested id set with `deletedEvents`;
   a partial match can succeed. Verify coin identity from D1 before execution.

   ```bash
   npx tsx worker/scripts/one-shot-backfill.ts audit-depeg-history --query 'delete=<reviewed-ids>' --execute --allow-atomic-import | jq
   ```

   Schedule a maintenance window: the atomic import can briefly make D1 unavailable
   to the live Worker. A confirmed completed command's `deletedEvents` lists removed
   rows and `daysRecomputed` the PSI days repaired. `409` (`DDRv2 sealed repair
   required` or `DDR incident member delete refused`) lists the conflicting
   ids and the run must stop for those ids. `500`
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

   Sync reserves prior slugs by durable event ID, including slugs of removed IDs,
   before assigning newcomers. Ordinary same-day additions need no shrink override.
   If a reviewed backfill rewrites event IDs, retain an explicit old-ID/slug →
   surviving-ID/slug mapping in the repair evidence and add the direct redirects
   before running the shrink-approved refresh. Never infer identity from symbols
   or globally rename existing URLs. Reusing an existing ID for another stablecoin
   is rejected, including with the shrink override.

5. **Verify.** Re-read the coin's history
   (`GET https://api.pharos.watch/api/depeg-events?stablecoin=<coin-id>` with a
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
- [`docs/depeg-detection.md`](../depeg-detection.md) — replay and suppression semantics.
- [Event history and crawlability](../depeg-page.md#event-history-and-crawlability) —
  permanent archive and redirect continuity.
