# GYD Cemetery Investigation

Date: 2026-04-14

## Scope

Investigated whether Gyroscope GYD (`gyd-gyroscope`) should remain in the active stablecoin registry or move to the cemetery.

## Evidence

- Official Gyroscope post `2017546048114250219` was created on 2026-01-31 10:30:36 UTC and said the GYD cross-chain contract was exploited, users should not interact with GYD, and GYD Gyro liquidity pools were paused.
- Official Gyroscope post `2018666720890646571` was created on 2026-02-03 12:43:45 UTC and proposed a settlement to recover 200 ETH so the protocol could make users whole.
- Ethereum RPC logs for `0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a` show the latest Transfer event at block `24353793`, timestamp `2026-01-31T08:54:59Z`, transaction `0x035abf7c1ebfe4283b9d3875ee5a2cbc2993a9f8056678408cfee68194ab8b2a`.
- Etherscan reports GYD circulating supply as zero and circulating market cap as zero on the Ethereum token page.
- CoinGecko API no longer resolves `gyroscope-gyd` through `/coins/gyroscope-gyd` or search.
- Pharos live DEX liquidity showed no 24h/7d volume and Balancer pools that are one-sided GYD inventory with zero effective TVL.
- DefiLlama stablecoins list still reports old token supply around 26.6M, but its detail endpoint has no current price/circulating payload for the asset. The stale supply alone is not enough to keep GYD active.

## Decision

Move GYD to the cemetery as a February 2026 counterparty-failure death. Keep contract addresses on the cemetery entry, remove active redemption-backstop and mint/burn configs, and update registry/docs counts.
