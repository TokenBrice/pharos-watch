# `locked-verdict-replay.json` — lock-time evidence provenance

`locked-verdict-replay.json` pins the 72 reviewed public DDR predictions used by
`../locked-verdict-replay.test.ts`. Every row's `lockTime` and `recordedDuration`
block is read back from production D1 (`stablecoin-db`); nothing in them is
hand-authored.

## Extraction query (read-only)

```sh
npx wrangler d1 execute stablecoin-db --remote --json --command "
SELECT
  p.id                                                                          AS publicPredictionId,
  p.event_id                                                                    AS lockTimeEventId,
  p.locked_at                                                                   AS lockedAt,
  json_type(p.sealed_payload_json, '\$.frozen.sourceRow.status')                 AS sealedStatusJsonType,
  json_extract(p.sealed_payload_json, '\$.frozen.sourceRow.status')              AS sealedStatus,
  json_type(m.registry_snapshot_json, '\$.status')                               AS membershipStatusJsonType,
  json_extract(m.registry_snapshot_json, '\$.status')                            AS membershipStatus,
  json_extract(p.sealed_payload_json, '\$.frozen.resolution.tier')               AS recordedTier,
  json_extract(p.sealed_payload_json, '\$.frozen.resolution.factors')            AS recordedFactors,
  json_extract(p.sealed_payload_json, '\$.frozen.sourceRow.peakDeviationBps')    AS peakDeviationBps,
  json_extract(p.sealed_payload_json, '\$.frozen.sourceRow.currentDeviationBps') AS currentDeviationBps,
  json_extract(p.sealed_payload_json, '\$.frozen.duration.suppressed')           AS durationSuppressed,
  json_extract(p.sealed_payload_json, '\$.frozen.duration.suppressedReason')     AS durationSuppressedReason,
  json_extract(p.sealed_payload_json, '\$.frozen.duration.medianSec')            AS durationMedianSec,
  json_extract(p.sealed_payload_json, '\$.frozen.duration.ageStatus')            AS durationAgeStatus,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.supplyChange7dPct')     AS supplyChange7dPct,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.supplyChange30dPct')    AS supplyChange30dPct,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.mintSurge')            AS mintSurge,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.liquidityScore')       AS liquidityScore,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.dewsBand')             AS dewsBand,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.dewsScore')            AS dewsScore,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.safetyGrade')          AS safetyGrade,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.safetyScore')          AS safetyScore,
  json_extract(p.sealed_payload_json, '\$.frozen.relatedContext.safetyContext.status') AS safetyContextStatus
FROM depeg_resolver_public_predictions p
LEFT JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = p.incident_key
WHERE p.id <= 73
ORDER BY p.id
" | sed -n '/^\[/,$p' | jq '.[0].results'
```

`p.id` is the fixture's `publicPredictionId`; `ddrr-<n>` in `rowId` is that id.
The 72 fixture rows cover ids 1–73 (id 23 is a sealed prediction that never
entered the reviewed corpus). Extracted 2026-09-09 against 102 sealed rows.

## What the record proves

- `frozen.sourceRow.status` is JSON `null` (`json_type` = `null`, key present) for
  all 73 rows, corroborated independently by
  `depeg_resolver_incident_policy_membership.registry_snapshot_json` `$.status`
  and by `depeg_resolver_assessments.row_json` `$.status`. No coin in the corpus
  was frozen or dead at lock, so the test may not reconstruct a `"frozen"`
  registry status.
- `frozen.resolution.tier` equals the fixture's `expectedTier` and
  `frozen.resolution.factors` (code/kind/severity) equals `sourceFactors` for all
  72 rows — the answer columns are the recorded verdict, not an editorial guess.
- `p.event_id` (identical to `frozen.sourceRow.eventId`) is the lock-time event.
  The fixture's original `eventId` disagreed on 28 rows (it carried a later event
  id for the same incident) while `startedAt` matched everywhere; the field now
  holds the recorded lock-time id.

## Fields the record does not preserve

Raw resolver inputs are not stored anywhere: `depeg_resolver_assessments.row_json`
is the same source-row projection as the sealed payload and carries no
`mechanismArchetype` and no `tvlChange7d` on any of the 73 rows. These therefore
stay a synthetic reconstruction back-solved from the recorded attributions in
`../locked-verdict-replay.test.ts`:

- registry structure: `mechanismArchetype`, `mintPath`, `authorityPosture`,
  `collateralQuality`, `custodyModel`, `reserves`, `canBeBlacklisted`,
  `dependencyImpaired`, `windDownAnnouncedAt`;
- redemption backstop: `redemptionCapacityRatio`, `redemptionRouteFamily`;
- DEX/TVL trends: `tvlChange7d`, `tvlChange30d`, `volumeChange30d`,
  `totalVolume24hUsd` (`SYNTHETIC_DEX_CONTEXT`);
- the historical incident set behind `R5_proven_meanreversion`.

Because those remain synthetic, a matching resolver verdict is scenario
agreement, not historical replay.

## Refreshing

Re-run the query above, merge `lockTime` / `recordedDuration` per
`publicPredictionId`, and keep the file minified with a trailing newline. Never
hand-edit an evidenced value.
