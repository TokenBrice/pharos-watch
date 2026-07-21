# CDP Shock-Coverage Refresh

Operational reference for the automated V9 CDP shock-coverage measurement.

CDP shock coverage is a score-bearing V9 fact with a **72-hour** policy freshness bound, ratified in `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` under `semantic.backing.structural.cdp.stressMeasurementFreshness`. Past that bound the engine fails closed to legacy LCR: LUSD drops from roughly 77/B+ to 59/C via `unsafe-backing:high`, and BOLD's A rating falls with it.

Until now the measurement was produced by hand. The [Shock Coverage Refresh](../../.github/workflows/shock-coverage-refresh.yml) workflow closes that manual dependency under the LUSD and BOLD safety scores.

## Cadence

`.github/workflows/shock-coverage-refresh.yml` runs at **03:41 UTC every other day** (`41 3 */2 * *`), plus `workflow_dispatch` for a manual refresh.

Worst-case gap between runs is 48h, which leaves ~24h of slack against the 72h bound — enough to absorb one failed run, not two. The freshness clock runs on the **pinned block timestamp**, not on merge time, so merge latency spends the same budget as scheduler latency; auto-merge (see [Merge path](#merge-path)) keeps that spend bounded by the required checks.

## What the workflow does

| Stage                     | Command                                                                     | Failure meaning                                          |
| ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Measure Liquity V1        | `measure-cdp-shock-coverage.ts --asset lusd-liquity`                        | No RPC endpoint served a complete position snapshot      |
| Measure Liquity V2        | `measure-cdp-shock-coverage.ts --asset bold-liquity`                        | Same, for the BOLD branch set                            |
| Attest journal replays    | `generate-safety-score-v9-shock-coverage-attestations.ts`                   | A journal did not replay byte-identically offline        |
| Regenerate registry       | `generate-safety-score-v9-shock-coverage-registry.ts`                       | Journal/registry projection is inconsistent              |
| Verify self-consistency   | both generators with `--check`                                              | A generated artifact is stale after its own run          |
| Assert scoring freshness  | `scripts/ci/check-shock-coverage-freshness.mjs`                             | A target is missing, incomplete, unattested, or too old  |
| Run shock-coupled tests   | `vitest` over the registry, extension-shock, and fact-set suites            | The refreshed data would fail the PR gate — the PR would be unmergeable |

Each stage is a separate step, so a partial refresh (for example V1 succeeding and V2 failing) fails the job **before** any branch, commit, or PR is created. Nothing unverified reaches the registry.

### Replay attestations are load-bearing

`shared/lib/safety-score-v9/archetypes/cdp.ts` rejects any measurement where `exactReplayPassed` is false or `replayVerification` is null, with reason `stress-measurement-exact-replay-not-passed`. A journal committed without a matching attestation therefore scores exactly as if it were missing.

`generate-safety-score-v9-shock-coverage-attestations.ts` replays every journal whose sha256 does not already carry a passing attestation, and reuses cached entries otherwise. Any divergence throws without writing. Re-running it with `--check` verifies the attestations file is current.

Each attestation entry carries its own `attestedAt` — the date that journal was actually byte-replayed. Cached entries keep their original date on later runs, and the registry projects the per-entry date, so a refresh only adds rows for newly attested journals and never rewrites historical `replayVerification` metadata. The file-level `attestedAt` only records the latest replay run.

## Merge path

`main` is a protected branch with `enforce_admins: true` and force-pushes disabled, so the workflow **cannot** push measurements directly. It pushes to `automated/shock-coverage-refresh` and opens (or force-updates) a pull request against `main`, matching the [OG Refresh](../../.github/workflows/og-refresh.yml) pattern.

The workflow **arms auto-merge** on the PR it opens (`gh pr merge --squash --auto`; repository auto-merge is enabled) per the owner ruling of 2026-07-20. The merge queues behind the required checks — branch protection is not bypassed — and does not wait for a human review, because a refresh parked on review can still cross the 72h bound and drop LUSD to `unsafe-backing:high`. The trust boundary is the measurement itself: journals must replay byte-identically offline or the job fails before a PR exists (see above). Note that replay proves determinism, not RPC truthfulness; accepting public-RPC measurements without human review is a deliberate freshness-over-review trade (ruling reaffirmed 2026-07-21 by rejecting PR #611, which proposed removing auto-merge).

### Token

The PR step uses `SHOCK_COVERAGE_GITHUB_TOKEN`, falling back to the existing `OG_REFRESH_GITHUB_TOKEN`. A bot or PAT token is required so the automated PR triggers normal `pull_request` checks; the default `GITHUB_TOKEN` would not. The workflow fails with an explicit error when neither secret is set.

The measurement itself needs **no** credential. `scripts/lib/mechanism-measurement/shock-targets.ts` carries a hardcoded list of public Ethereum archive RPC endpoints with per-endpoint failover.

## Manual refresh

```bash
npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts --asset lusd-liquity
npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts --asset bold-liquity
npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-attestations.ts
npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-registry.ts
node scripts/ci/check-shock-coverage-freshness.mjs
```

Measuring the same head block twice is idempotent: the measure script keeps the existing journal and verifies the new measurement matches it, rather than overwriting.

To byte-replay a single journal on demand:

```bash
npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts --replay <journal-path>
```

## Related

- [Safety Score V9 readiness](./safety-score-v9-readiness.md)
- [Safety Score V9 rollout](./safety-score-v9-rollout.md)
