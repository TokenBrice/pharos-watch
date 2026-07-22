# Protocol API Mechanism Refresh

The [Protocol API Mechanism Refresh](../../.github/workflows/protocol-api-mechanism-refresh.yml) captures current synthetic/yield mechanism evidence without changing the active Safety Score identity. The first target is `usde-ethena`, using Ethena's collateralization-status and proof-of-reserves APIs.

## Contract

The workflow runs weekly and writes append-only, schema-validated evidence under `shared/data/safety-score-v9/mechanism-measurements/<assetId>/`. The source observation timestamp keys each artifact, so a retry against unchanged source evidence is an idempotent no-op; changed evidence under the same timestamp fails rather than overwriting the prior record. Each artifact preserves the normalized source payloads, source timestamps, confirmed PoR auditors, and deterministic candidate metrics:

- collateralization ratio and nonnegative excess-backing margin
- Reserve Fund share of token supply
- the latest attested delta-neutral and overcollateralized states

Collateralization observations older than 12 hours, PoR observations older than 10 days, future timestamps, unconfirmed reports, and implausible ratios fail before an artifact is written. Ethena's report attests whether the backing is delta neutral but does not publish a quantitative position ratio, so `hedgeCoverageRatio` remains `null` for both positive and adverse attestations rather than inventing coverage. USDe has no CDP liquidation surface or protocol liquidation-capacity endpoint, so `liquidationCapacityUsd` is also explicitly `null`.

## Adoption Boundary

These files are measurement inputs only. The workflow never edits `mechanism-review-overlays-v1.json`, the V9 policy, or a score registry. A later reviewed identity rotation decides whether and how a measurement is adopted; continuous collection can confirm a restrictive disposition as readily as it can support clearing one.

The automation opens or updates `automated/protocol-api-mechanism-refresh` and deliberately does not arm auto-merge. It uses `MECHANISM_REFRESH_GITHUB_TOKEN`, with the existing shock-coverage or OG refresh tokens as fallbacks, so normal pull-request checks run.

## Manual Use

```bash
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts
npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --replay <artifact.json>
```

Replay rebuilds every derived field from the recorded source payloads and capture time, then requires byte-identical JSON.
