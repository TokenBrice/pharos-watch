## AI Summary Writer — Extended Reference

Material moved verbatim from `SKILL.md`: the data-source field catalogs and additional editorial angles.

### Data Sources

#### Static Metadata (always read)

Stablecoin metadata lives in `shared/data/stablecoins/coins/*.json` (generated into `shared/data/stablecoins/coins.generated.json` at build-time). Find the coin's entry by `id` and check:

- **Classification flags**: `flags.backing`, `flags.governance`, `flags.pegCurrency`, `flags.yieldBearing`, `flags.navToken`
- **Collateral & mechanism**: `collateral` (free-text description), `pegMechanism` (how peg is maintained)
- **Reserve composition**: `reserves[]` — slices with `name`, `pct`, `risk` (very-low to very-high), and optional `coinId` + `depType` for dependency tracking. This reveals concentration risk, exotic collateral, and upstream dependencies
- **Resilience sub-factors**: `custodyModel` (onchain / institutional-top / institutional-regulated / institutional-unregulated / cex), `chainTier` (ethereum / stage1-l2 / mature-alt-l1 / unproven), `collateralQuality` (native / rwa / eth-lst / exotic), `governanceQuality` (immutable-code / dao-governance / multisig / regulated-entity / single-entity), `deploymentModel` (single-chain / canonical-bridge / native-multichain)
- **Jurisdiction**: `jurisdiction.country`, `jurisdiction.regulator`, `jurisdiction.license`
- **Proof of reserves**: `proofOfReserves.type` (independent-audit / real-time / self-reported), `.provider`
- **Dependencies**: `dependencies[]` — upstream stablecoins with `weight` and `type` (wrapper / mechanism / collateral)
- **Blacklist exposure**: `canBeBlacklisted` (true / false / "possible")
- **Yield config**: `yieldConfig.yieldSource`, `yieldConfig.yieldType` (lending-vault / rebase / fee-sharing / lp-receipt / nav-appreciation / governance-set)
- **Deployment footprint**: `contracts[]` (count and chains), `tradedContracts[]`
- **Notices**: `notices[]` — danger/warning/info notices the page surfaces to users
- **Links**: `links[]` — official sources for fact-checking

#### Live Analytical Data (check when refreshing or writing high-profile coins)

The detail page at `pharos.watch/stablecoin/{id}` shows live scoring and analytical data. Use the browser tool (claude-in-chrome or Playwright in Claude Code; `agent-browser` in Codex) to check:

- **Report card**: Overall grade (A+ to F/NR) and 5-dimension breakdown — peg stability, liquidity, resilience, decentralization, dependency risk. Look for the interesting story: a strong overall grade with one weak dimension, or vice versa
- **Peg score**: 0-100 score, active depeg status, depeg event count, worst historical deviation
- **Liquidity score**: 0-100 score, DEX TVL, concentration (HHI), coverage class (primary vs fallback)
- **Redemption backstop**: Route family (stablecoin-redeem / collateral-redeem / psm-swap / offchain-issuer), access model (permissionless vs whitelisted), settlement speed, fee bps, capacity ratio
- **DEWS stress band**: CALM / WATCH / ALERT / WARNING / DANGER
- **Yield**: Current APY, yield-to-risk ratio, safety grade
- **Mint/burn flows**: Net flow direction, flow intensity, pressure shift

### What to Cover — additional angles

- **Reserve structure**: When the reserve composition tells a story — concentration in a single asset, dependency chains through other stablecoins, exotic collateral, mismatches between backing claims and actual slices — interpret it
- **Exit liquidity reality**: Can you actually get out? The combination of redemption backstop data (route family, access model, settlement speed) and DEX liquidity (TVL, concentration, coverage class) tells the real story of how trapped your dollars are
- **Dependency chain**: When a stablecoin wraps or depends on other stablecoins, trace the trust chain. A coin backed by a coin backed by BlackRock's BUIDL is three layers deep — that's worth noting
