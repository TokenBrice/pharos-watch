## Redemption backstop degraded investigation

Date: 2026-04-01

Question: does the current `sync-redemption-backstops` degraded status require an operational fix?

### Live snapshot checked

- `https://api.pharos.watch/api/redemption-backstops`
- Current snapshot `updatedAt = 1775023950`
- Unresolved routes: `gho-aave`, `usdf-falcon`, `wsrusd-reservoir`
- All three are `resolutionState = "missing-capacity"`
- No route-level failures (`failed = 0`)
- DEX liquidity freshness is not stale (`liquidityStale = false`)

### Why the cron is degraded

`worker/src/cron/sync-redemption-backstops.ts` marks the job `degraded` whenever any configured route is unresolved, missing from cache, failed, or liquidity is stale. Current run metadata matches that exact path:

- `resolved = 141`
- `unresolved = 3`
- `failed = 0`
- `configured = 144`

So the degraded badge does not indicate a runtime failure in the redemption cron itself. It indicates incomplete scoring coverage under the current truth-boundary rules.

### Per-asset findings

#### `gho-aave`

- Public reserves endpoint shows `sync.status = "degraded"` but fresh (`stale = false`, `lastSuccessAt = 1775023891`)
- Warning:
  - `Residual GHO issuance outside tracked GSM backing remains aggregated ... (63.59%)`
- Redemption route note:
  - `Live reserve metadata degraded; latest snapshot not in ok state`

Assessment:

- This is a real quality gate, not an outage.
- The redemption model only wants direct GSM-backed immediate capacity.
- With ~63.6% of supply outside tracked GSM backing, rating the route as a scored direct backstop would overstate redeemable capacity.
- Action is only warranted if we can materially extend the onchain coverage of redeemable GSM modules or introduce a justified fallback. Otherwise the unrated state is the correct conservative output.

#### `usdf-falcon`

- Public reserves endpoint shows `sync.status = "degraded"` but fresh (`lastSuccessAt = 1775023886`)
- Warning:
  - `Unmapped Falcon asset: DUSK ($105100, 0.01%)`
- Redemption route note:
  - `Live reserve metadata degraded; latest snapshot not in ok state`

Assessment:

- This does not look operationally broken.
- The adapter extracted a full reserve mix and a stable bucket, but one tiny unmapped asset triggers a degraded reserve snapshot.
- The unknown share is only `0.01%`, so the current downgrade looks stricter than the actual materiality of the issue.
- If we want to reduce noisy degraded statuses, the cleanest fix is to map `DUSK` or relax Falcon unknown-asset warning severity so trivial tail assets do not flip the entire reserve snapshot to degraded.

#### `wsrusd-reservoir`

- Public reserves endpoint shows `sync.status = "ok"` and fresh worker fetch (`lastSuccessAt = 1775023929`)
- Provenance shows `freshnessMode = "unverified"` and `scoringEligible = false`
- Warning:
  - `Upstream reserve source timestamp is unavailable ... freshness remains unverified`
- Redemption route note:
  - `Live reserve metadata lacks scoring-grade freshness evidence`

Assessment:

- This is not a failure.
- The adapter is working, but the upstream Reservoir payload does not provide a trustworthy source timestamp.
- Current redemption logic intentionally refuses to score reserve-sync capacity without scoring-eligible freshness evidence.
- No immediate code fix is required unless we want to loosen that policy or source a trustworthy upstream timestamp. Keeping it unrated is conservative and aligned with the documented rules.

### Conclusion

No urgent operational remediation is required. The degraded badge currently means:

- the cron ran successfully,
- wrote all 144 rows,
- and conservatively left 3 reserve-dependent routes unrated.

The only item that looks fix-worthy from our side for noise reduction is `usdf-falcon`, where a de minimis unmapped asset currently downgrades the reserve snapshot. The other two (`gho-aave`, `wsrusd-reservoir`) appear to be honest conservative gating under the current methodology.

### If we want this job to turn green more often

Potential follow-ups, ordered by expected value:

1. Map Falcon `DUSK` or lower the severity threshold for tiny unknown exposures so `0.01%` tails do not force `sync.status = degraded`.
2. Add stronger GHO direct-capacity coverage only if we can prove more redeemable GSM backing; otherwise keep it unrated.
3. Improve Reservoir freshness evidence only if the upstream API can expose a trustworthy source timestamp; otherwise keep the route unrated or explicitly downgrade expectations in status semantics.
4. Revisit cron status semantics if persistent, methodologically-intentional unrated routes should not mark the whole job degraded.
