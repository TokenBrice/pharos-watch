# Lane freshness and tolerated incompleteness

**Draft for owner sign-off.** This is a review yardstick, not a runtime policy change or permission to relax admission. The source files win if this review snapshot drifts.

## Authority and interpretation

- [`CRON_JOB_DEFINITIONS`](../../shared/lib/cron-jobs.ts) supplies all 48 logical jobs, effective intervals, `statusImpact` and `freshnessSurface`; [`cron-cadences.ts`](../../shared/lib/cron-cadences.ts) supplies inherited intervals. Physical triggers, conditional recovery paths and budget-only side work are not additional logical jobs.
- The current cron freshness budget is **2 × effective interval**. Consumer jobs require confirmed output, not merely an `ok` attempt; `freshnessSurface: none` jobs require a completed observation. A fresh heartbeat proves liveness, never publication. See [cron health model](../status-dashboard.md#cron-health-model) and [`cron-health.ts`](../../worker/src/lib/status/cron-health.ts).
- In the table, **C** means consumer output and **O** means completed control-plane observation. The watchdog separately uses 2× warning / 3× escalation; endpoint/cache/evidence budgets in [`status-thresholds.ts`](../../shared/lib/status-thresholds.ts) and dataset descriptors remain independent. The table is not a replacement for those policies.
- `critical` is the current availability-impacting tier: one fresh failure degrades, consecutive required errors or multiple unhealthy critical lanes can make availability stale. `watch` is diagnostic/admin-only for cron availability; the job's downstream cache, data quality or public component may independently affect status. See [error escalation](../status-dashboard.md#cron-error-escalation).
- Every proposed tolerance below is conditional on retained usable output, explicit incomplete cohorts/reasons and unchanged trust gates. Unavailable is not zero. Synthetic unstarted required children stay errors and are grouped by invocation; generic neutral/locked skips never establish publication. Proven-satisfied period readbacks keep their existing narrow semantics.

## Logical-job matrix

| Logical job | Effective interval | Current freshness budget / evidence | Current status impact | Proposed tolerated incompleteness (owner review) |
| --- | --- | --- | --- | --- |
| `sync-stablecoins` | 15m | 30m C | critical | Quarantine invalid assets; publish admitted cohort with explicit coverage; no missing required publication beyond budget. |
| `sync-stablecoin-charts` | 1h | 2h C | watch | Partial source coverage only when retained rows remain named and aged; no invented chart points. |
| `sync-fx-rates` | 30m | 1h C | critical | Retain only provenance-qualified source rates; missing currencies remain unavailable, not assumed USD. |
| `stability-index` | 30m | 1h C | watch | No incomplete constituent aggregate without explicit cohort coverage; retained PSI keeps original clock. |
| `compute-dews` | 30m | 1h C | watch | Quarantine invalid inputs per asset; retain explicit held outputs, never renew held clocks. |
| `project-tape` | 30m | 1h C | watch | Idempotent backlog catch-up within budget; no duplicated/missing event claims. Geography canary yardstick unchanged. |
| `reserve-recovery` | 5m | 10m O | critical | Protected verified producer-live poll allowed; no claim that a poll completed a reserve cohort. |
| `status-self-check` | 15m | 30m C | watch | Scheduled deep-probe rotation allowed; skipped or failed probe evidence remains explicit, never healthy by omission. |
| `data-invariant-canary` | 15m | 30m C | watch | No missing active checks hidden by clean measured checks; findings are separate from observer execution. |
| `cron-sentinel` | 15m | 30m O | watch | No unavailable telemetry reclassified as zero incidents; bounded evidence collection can be partial with reasons. |
| `dispatch-telegram-alerts` | 5m | 10m O | watch | Durable pending queue and bounded retries allowed; enqueue is not delivered evidence. |
| `telegram-degradation-watchdog` | 5m | 10m O | watch | Durable broker retry allowed; unavailable broker state remains unknown. |
| `telegram-disambiguation-cleanup` | 5m | 10m O | watch | Bounded cleanup batches allowed; residual expiry backlog remains visible. |
| `telegram-pulse-snapshot` | 5m | 10m C | watch | Quiet/empty measured pulse allowed; failed source read cannot become an empty pulse. |
| `sync-blacklist` | 6h | 12h C | critical | Confirmed quiet scan allowed; gaps retain configuration/safe-head identity and never relax coverage admission. |
| `sync-mint-burn` | 30m | 1h C | critical | Quiet confirmed scan allowed; incomplete critical scan remains explicit and cannot renew full-pass evidence. |
| `sync-mint-burn-extended` | 30m | 1h C | watch | Draft replacement yardstick: completed full pass within expected `coverageCycleSec`, not a fixed 75m clock; never mask critical lane. |
| `sync-dex-discovery` | 2h | 4h C | watch | Cron-native checkpoint continuation allowed with remaining cohort/backlog; no claim of completed discovery before completion. |
| `sync-cl-exit-depth` | 30m | 1h C | watch | Partial chain/venue observations allowed only with named coverage and original per-observation clocks. |
| `sync-dex-liquidity-stage` | 1h | 2h C | watch | Named partial source findings allowed; exact-slot source generation must be complete enough for consumer admission. |
| `sync-dex-liquidity` | 1h | 2h C | watch | Partial source quality can accompany real publication; no mixed-generation publish. V9's independent DEX evidence window stays 4h. |
| `sync-yield-data` | 1h | 2h C | critical | Publish admitted ranking cohort with explicit coverage; held safety inputs retain their clock and cannot justify destructive cleanup. |
| `sync-yield-supplemental` | 4h | 8h C | watch | Per-family partial refresh allowed with family age/coverage; no relabeling fallback as fresh acquisition. |
| `snapshot-supply` | 1d | 2d C | watch | Same-day proven artifact readback allowed; no zero supply for missing inputs or duplicate day. |
| `snapshot-chain-supply` | 1d | 2d C | watch | Same-day proven readback allowed; absent chain evidence remains absent rather than zero. |
| `sync-v9-supply-attribution` | 30m | 1h C | watch | Bounded attribution-pending allowed only for exact unexpired source request; never admit a future packet. |
| `compute-safety-score-v9` | 30m | 1h C | watch | Keep :22/:52 publication lead. Held publication keeps prior clock and is publicly visible, not a fresh successful generation. |
| `prepare-safety-score-v9-input` | 30m | 1h C | watch | Exact-input pending/deferred state allowed; no incomplete/future compiler input treated as ready. |
| `compute-depeg-resolver` | 15m | 30m C | watch | Bounded repair backlog allowed with event identities; corpus rollup must preserve verdict equivalence. |
| `snapshot-safety-grade-history` | 1d | 2d C | watch | One artifact per day; proven readback allowed, held source never fabricates a new grade observation. |
| `fetch-tbill-rate` | 1d | 2d C | watch | Per-key benchmark partial refresh visible; no stale market observation relabeled as refreshed. |
| `snapshot-psi` | 1d | 2d C | watch | One valid snapshot/day or proven readback; missing PSI never becomes zero. |
| `snapshot-public-dataset` | 1d | 2d C | watch | Atomic admitted snapshot required; partial capture cannot claim a complete public dataset. |
| `sync-usds-status` | 1d | 2d C | watch | Retain last observed state with original clock; failed chain read is unknown, not unchanged. |
| `sync-live-reserves` | 4h | 8h C | watch | Continuation is normal; **full cohort ≤30m p95**, alert beyond. Per-asset retained fallback remains aged and explicit. |
| `sync-redemption-backstops` | 4h | 8h C | watch | Named unavailable/impaired routes allowed; unresolved capacity/read failures retain reasons and coverage. |
| `sync-kinesis-supply` | 4h | 8h C | watch | Partial metal feed remains explicit; unavailable KAU/KAG observation never becomes zero supply. |
| `sync-bluechip` | 1d | 2d C | watch | Partial-cache merge allowed with per-entry provenance and quality findings, not a whole-cohort refresh claim. |
| `daily-digest` | 1d | 2d C | watch | Publication phases may retry durably; idle conditional poll is no obligation, started/required failure stays visible. |
| `weekly-recap` | 7d | 14d C | watch | Existing-period proven readback allowed; no duplicate recap, delivery retains its own evidence. |
| `yield-coverage-audit` | 30d nominal | 60d C | watch | Calendar-month schedule; incomplete audit names unmeasured cohort, never counts unknown as covered. |
| `observe-rpc-provider-parity` | 1h | 2h O | watch | Partial provider samples allowed only as partial research evidence; never affect public availability directly. |
| `prune-status-probe-runs` | 1d | 2d O | watch | Bounded prune continuation allowed with remaining backlog; no hot retention extension for incident archives. |
| `prune-cron-history` | 1d | 2d O | watch | Bounded prune continuation allowed; 21-day evidence belongs in GitHub artifacts, not this table. |
| `prune-detail-cache` | 1d | 2d O | watch | Bounded orphan/stale cleanup allowed; never delete current admitted generation. |
| `telegram-inactive-cleanup` | 7d | 14d O | watch | Bounded inactive-user cleanup allowed; partial execution does not claim all eligible users processed. |
| `telegram-retention-cleanup` | 1d | 2d O | watch | Bounded retention/reconciliation allowed with residual backlog; no lost pending deliveries. |

## Sign-off boundary

Owner review must approve any proposed tolerance before it becomes an executable acceptance threshold. In particular, the reserve cohort completion SLO, extended mint/burn cycle verdict, DEX source-to-consumer identity and V9 held-publication component are separate contracts, not reasons to extend current cron age budgets. Runtime changes must update their source authority and this draft together. Incident assessment uses [literal terminal/output evidence](../scripts.md#worker-incident-evidence-and-status-profile), not a count of every non-`ok` row labeled “degraded”.
