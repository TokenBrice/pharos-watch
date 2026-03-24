# Live Reserve Coverage Priorities — 2026-03-24

Current production ranking by market cap among non-live reserve assets, using `https://api.pharos.watch/api/stablecoins`:

1. `usdd-tron-dao-reserve` — ~$1.17B
2. `ousg-ondo-finance` — ~$688M
3. `ylds-figure` — ~$586M
4. `usx-solstice` — ~$359M
5. `kau-kinesis` — ~$337M
6. `usda-avalon` — ~$267M
7. `reusd-re-protocol` — ~$182M
8. `satusd-river` — ~$158M
9. `usdf-astherus` — ~$125M
10. `cash-phantom` — ~$122M

Implementation triage:

- `reusd-re-protocol`: implemented. Public `https://app.re.xyz/metrics` HTML embeds machine-readable reserve payloads for on-chain token composition plus current off-chain capital.
- `usdd-tron-dao-reserve`: implemented. `https://usdd.io/data` calls public JSON endpoints under `https://app-api.usdd.io/data-platform/`, including `latest-collateral?chain=tron`.
- `ousg-ondo-finance`: large impact but explicitly blocked in repo notes because the oracle is access-restricted for non-whitelisted callers.
- `ylds-figure`: large impact, but the public site exposes narrative/prospectus content rather than a machine-readable live reserve breakdown.
- `usx-solstice`: marketing page confirms reserve claims, but no stable public reserve API or embedded live composition was found from the public site.
- `cash-phantom`: public site is accessible, but no reserve composition payload surfaced from the public HTML. Browser inspection only exposed marketing content plus legal links.
- `satUSD-river`: partial lead only. `https://river.inc/` links a public `https://api-v2.satoshiprotocol.org/protocol-info` endpoint, but it only exposes aggregate TVL and circulation by chain, not the live collateral mix needed for reserve slices.
- `usda-avalon`: blocked by frontend geofencing. `https://app.avalonfinance.xyz/earn` currently resolves to `https://restrict.avalonfinance.xyz/` with an access-restricted page from this environment.
- `kau-kinesis`: no current public reserve API, embedded JSON payload, or app endpoint surfaced from the public `kinesis.money` page during this pass.
