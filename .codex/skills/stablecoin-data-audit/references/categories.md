# Static-Data Audit Categories and Sources

The base coin files in `shared/data/stablecoins/coins` and matching domain sidecars under `shared/data/stablecoins/domains` are the review inputs. Use the live schema and owning source files when a field’s shape or default is unclear.

## Categories

Review only concrete factual or internal-consistency errors in these categories:

- identity: name, symbol casing, one-liner, and peg currency
- mechanism: collateral, peg mechanism, and mechanism archetype
- flags: backing, governance, yield-bearing, RWA, and NAV-token consistency
- mint-authority: malformed addresses or source-contradicted threshold/signer count
- chains-contracts: announced live deployments, addresses, and decimals
- identifiers: CoinGecko, DefiLlama, CoinMarketCap, Pyth, or protocol identifiers resolving to this asset
- links: label-to-target match, official domain, and liveness
- jurisdiction: country, regulator, and license
- mica: clear MiCA status, entity, or domicile facts only
- genius: clear GENIUS status, entity, or domicile facts only
- proof-of-reserves: provider, cadence, attestor, and URL
- reserves: composition versus current disclosure and the coin’s own collateral prose
- issuance-date: launch, announcement, expected-launch, and stale pre-launch dates
- lifecycle-status: active/frozen/pre-launch state, dates, obituary facts, and launch phase
- resilience: factual bridge-route, custody-model, or collateral-quality basis
- other: a concrete factual field that does not fit another category

Local contradiction screening does not establish external freshness for any category. A requested factual audit must include primary-source checks for its full requested category/cohort, not only locally flagged rows. Record checked, unverified, and unavailable coverage explicitly.

## Source sets

Discovery should prefer in-file contradictions: one-liner versus collateral/reserves, flags versus `yieldConfig`, collateral currency versus peg currency, address length, and archetype versus mechanism prose. It may cite only repo-relative paths. Verification may use primary issuer/regulator/register sources, official chain documentation and explorers, RWA.xyz, and the named identity providers. A provider must resolve to this token, not a same-name asset or affiliate; record the URL and what it proves.

## Exclusions

Never flag numeric scores or weights, oracle-risk scoring, dependency weights, reserves risk tiers, tags, featured content, notice wording, blacklistability prose, mint-authority narrative/provenance prose, subjective yield APRs, or stylistic preferences. Do not re-litigate nuanced compliance judgments or infer missing data merely because a schema default is absent: `pegCurrency`, `yieldBearing`, `rwa`, and `navToken` have defaults.
