# Yield Intelligence Operations

This note supplements [`docs/yield-intelligence.md`](./yield-intelligence.md) with runtime guardrails for the `sync-yield-data` cron.

## Slot Context

- `sync-yield-data` now runs on a dedicated hourly trigger at `20 * * * *`, after the `10,40 * * * *` charts / DEX lane has had time to settle. It does not depend on the separate `26,56 * * * *` DEWS / PSI lane.
- `sync-yield-supplemental` runs on its own slower `25 */4 * * *` trigger and feeds a cache snapshot that the hourly publisher consumes.
- The hourly publisher is now the freshness path for `yield-rankings`; optional upstream families are deliberately kept off that path.

## Runtime Guardrails

- Deterministic on-chain vault reads now run one asset at a time with a 6 second per-RPC timeout, explicit per-URL failover, and an explorer-proxy fallback for supported EVM chains when Worker RPC reads all return empty.
- When both a provider RPC and a public fallback are configured for a deterministic yield source, the reader probes the fallback/public URL first to avoid inheriting a sticky provider failure across the whole half-hourly slot.
- The hourly yield runtime forwards `ETHERSCAN_API_KEY` into deterministic reads so Ethereum-family explorer proxies can keep the publication path alive during transient Worker-to-RPC outages.
- Deterministic yield run metadata now splits RPC-vs-explorer failure buckets (for example `rpc-empty|etherscan-empty`) and records how many explorer fallbacks were attempted versus how many actually resolved.
- Repeated deterministic all-fail runs that are fully masked by non-onchain coverage now arm a 6-hour cooldown after the second consecutive masked failure. The cooldown skips the deterministic lane on the hourly publisher until either the cooldown expires or non-onchain coverage gaps reappear.
- Single-coin optional adapters are time-boxed to 12 seconds:
  - `BIMA sUSBD`
  - `Hashnote USYC`
  - `Ondo USDY oracle`
  - `B.Protocol LQTY-only`
  - `Curve scrvUSD current-rate`
- `sync-yield-supplemental` owns the heavier best-effort families. It writes a cached snapshot and does not overwrite the last good snapshot with an empty result.
- supplemental candidate dedupe now keys on source identity plus asset identity, not bare `sourceKey` alone, so same-chain families such as Aave V3 cannot collapse multiple coins into one cached row.
- `sync-yield-supplemental` metadata now reports raw candidate count, deduped candidate count, and dropped-row count so silent row loss is visible in cron history.
- read-time `yield-rankings` freshness warnings are now source-cadence-aware: hourly families trip after three hourly publish cycles, supplemental protocol-API plus optional Aave/Compound rows wait 6 hours so they do not false-positive during their normal 4-hour cache cycle, and `price-derived` rows wait 36 hours because their observations come from daily `supply_history` snapshots.
- Protocol API families use an 8 second per-request timeout, no retries, and a 25 second family budget:
  - `Morpho`
  - `Pendle`
  - `Yearn/Kong`
  - `Beefy`
- Optional RPC families use a 30 second family budget on the supplemental lane, a 10 second per-call timeout, two retries per URL, and alternating fallback/primary endpoint order across targets so one hot endpoint does not absorb the whole family burst:
  - `Compound V3`
  - `Aave V3`
- Optional RPC family metadata now records target counts, attempted counts, resolved target counts, emitted row counts, missing target counts, chain-level miss breakdowns, miss reasons, and whether the family budget exhausted before all targets were attempted.
- Aave on-chain reads are batched two assets at a time to stay below the Worker connection ceiling even on the isolated supplemental trigger.
- the monthly yield coverage audit now counts explicit auto-lending overrides and curated exact-pool overrides as covered DL surfaces, and its high-TVL gap list is scoped to unsupported protocol families so the report stays actionable.

## Failure Semantics

- Deterministic on-chain rows, curated DeFiLlama rows, price-derived rows, and rate-derived rows remain the primary publication path.
- A fully failed deterministic on-chain lane only degrades the cron when it leaves at least one configured coin without a non-onchain evaluated source in the same run; otherwise the run stays healthy and records the masked failure in metadata.
- If the deterministic cooldown is active but coverage gaps reappear, the hourly run degrades, clears the cooldown state, and retries the deterministic lane on the next hourly cycle.
- When an optional source budget is exhausted, the cron logs a warning and continues with the best remaining data instead of timing out the entire run.
- Chain-looped optional families keep any partial results they already collected before the budget expires.
- The intended failure mode for optional upstream stress is reduced supplemental coverage or an older cached supplemental snapshot, not a missing `yield-rankings` publish.
