## Noble Swaps endpoint probing (2026-04-16)

Goal: obtain a live fixture for Task G1 (Noble Swaps integration).
Verdict: no working endpoint found — **defer G1 to a follow-up plan that starts with an endpoint research spike**.

| URL | HTTP | Body |
| --- | --- | --- |
| `https://swap-api.noble.xyz/v1/simulate/stableswap/pools` | connection failure (curl exit `000`) | n/a |
| `https://noble-api.polkachu.com/noble/dollar/v2/state` | `501 Not Implemented` | `{"code":12,"message":"Not Implemented","details":[]}` |
| `https://swap.noble.xyz/api/pools` | `200` but HTML (Go module vanity page, not JSON) | `<!DOCTYPE html>… go-import swap.noble.xyz git https://github.com/noble-assets/swap …` |
| `https://rest.noble.xyz/noble/dollar/v2/state` | connection failure | n/a |
| `https://api.swap.noble.xyz/v1/pools` | connection failure | n/a |
| `https://lcd.noble.strange.love/cosmos/bank/v1beta1/supply` | connection failure | n/a |

For comparison, `https://noble-api.polkachu.com/cosmos/bank/v1beta1/supply` returned `200` with a real 9.9KB supply payload, so Polkachu's node _is_ reachable — the Noble Dollar module's v2/state endpoint is the piece that 501s.

### Recommendation for the plan

Defer **Task G1 (Noble Swaps fetcher)** in the remediation plan. G1 currently assumes a live `$NOBLE_API/pools` endpoint, but none of the candidate URLs return pool-level TVL / volume / balances in a machine-readable form as of 2026-04-16. Re-scope G1 as a research spike: (1) read the `noble-assets/swap` repo and identify the canonical query/CLI path, (2) if an RPC-only interface exists, decide whether the worker should make Cosmos gRPC-gateway calls or rely on a third-party indexer (Polkachu, Numia, NodeStake), (3) produce a working curl + fixture and only then proceed to fetcher implementation.

Until the spike is done, do not ship G1 in this plan.
