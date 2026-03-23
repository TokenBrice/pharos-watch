# Redemption Backstop Top-100 Medium-Coverage Plan

Date: 2026-03-24

## Goal

Prepare a realistic plan to move the Redemption Backstop module from current top-100 coverage to:

- `100/100` medium-or-better if that is defensible
- otherwise the highest credible medium-or-better count without weakening methodology standards

This plan focuses only on:

- `low -> medium`
- `missing -> medium`

It does not optimize for `medium -> high`.

## Current Baseline

Using the live snapshots already pulled for the investigation:

- stablecoins snapshot: `2026-03-23T23:15:19Z`
- redemption snapshot: `2026-03-23T23:13:16Z`

Top-100 current state:

- `67 medium`
- `6 high`
- `9 low`
- `18 missing`

So the current top-100 medium-or-better coverage is:

- `73 / 100`

Gap to full medium coverage:

- `27` assets

## Bottom Line

`100 / 100` is not realistic under the current methodology standard unless Pharos starts counting some weak or dubious routes as medium.

The realistic target is:

- **Base case:** `84-86 / 100`
- **Stretch case:** `88-90 / 100`

Why not 100:

1. some top-100 entries are legacy/numeric IDs or cemetery-style assets that need asset cleanup before redemption work
2. some assets do not currently have a credible holder redemption rail that cleanly fits the modeled route families
3. some cases are blocked on semantics, not implementation
4. a few names would require material methodology broadening to count as medium without overstating confidence

## Asset Triage

### Bucket A: Realistic medium-coverage upgrades

These are the names I believe Pharos can move to `medium` without diluting standards.

| Asset | Current | Why fixable | Main work needed |
| --- | --- | --- | --- |
| `usdd-tron-dao-reserve` | low | Existing route already modeled; low is from heuristic capacity | Replace heuristic ratio with live reserve / PSM telemetry |
| `reusd-re-protocol` | low | Existing route already modeled | Add documented bound or live queue/buffer telemetry |
| `usdf-astherus` | low | Existing route already modeled | Replace placeholder `15%` ratio with protocol-specific evidence |
| `dusd-standx` | low | Existing route already modeled | Replace placeholder `15%` ratio with issuer / liquidity evidence |
| `fpi-frax` | low | Existing route already modeled | Decide whether reviewed eventual redemption is strong enough for `documented-bound` |
| `lisusd-lista` | low | Existing route already modeled and docs already disclose fee/limit | Build a bounded capacity model from real protocol limits or live adapter data |
| `usr-resolv` | low | Existing route already modeled | Add Apostro/transparency-backed liquid-buffer evidence |
| `msusd-main-street` | low | Existing route already modeled | Validate direct redemption rail and attach reviewed docs or a bounded model |
| `yusd-aegis` | low | Existing route already modeled and reserve source exists | Publish redemption-relevant liquid buffer instead of generic reserve mix |
| `214` (`USDX Money USDX`) | missing | Large live asset, probably curation + config issue | Canonicalize asset, confirm route, add config |
| `pmusd-precious-metals` | missing | Research already flags live dashboard candidate | Review issuer redemption docs and add offchain-issuer config if route is credible |
| `315` (`US Permissionless Dollar`) | missing | Likely curation/config gap rather than methodology impossibility | Identify issuer/protocol docs and add route if credible |
| `210` (`Elixir deUSD`) | missing | Likely redeemable but unconfigured | Confirm redemption path and add config |
| `97` (`USP Stablecoin`) | missing | Likely config/curation candidate | Identify if there is a real protocol redemption rail |
| `usdm-mega` | missing | Already tracked in metadata corpus | Research route and add config if MegaUSD supports direct redemption |
| `susd-synthetix` | missing | Hard but not obviously impossible | Resolve current Synthetix holder redemption semantics first, then model if credible |
| `zchf-frankencoin` | missing | Research says data sources exist | Need explicit semantics decision plus route model |
| `mim-abracadabra` | missing | Mature CDP system with onchain data | Add collateral-redeem model if holder redemption is credible enough |

Count:

- `18` assets

If all 18 land, top-100 medium-or-better becomes:

- `91 / 100`

I would not promise all 18.

## Bucket B: Possible, but only after curation or methodology decisions

These are not clean implementation tickets yet.

| Asset | Current | Blocker |
| --- | --- | --- |
| `crvusd-curve` | missing | Reserve data exists, but the redemption-backstop question is whether there is a credible holder redemption rail comparable to current families |
| `frax-frax` | missing | Prior repo work treated canonical FRAX as outside redemption coverage; changing that needs a clear methodology decision |
| `bean` | missing | Redemption semantics are likely too weak / non-standard for current route families |

Count:

- `3` assets

If these 3 all become defensibly medium, the ceiling rises to:

- `94 / 100`

That is already a stretch.

## Bucket C: Probably not worth targeting for medium coverage

These should not be used to chase a vanity `100/100`.

| Asset | Current | Why not a near-term medium target |
| --- | --- | --- |
| `153` (`Binance Peg BUSD`) | missing | Bridge/legacy wrapper; curation problem first |
| `17` (`HUSD`) | missing | Legacy/distressed |
| `21` (`FLEXUSD`) | missing | Legacy / low-confidence curation case |
| `328` (`Mustang Finance`) | missing | Curation first; unclear route quality |
| `4` (`Binance USD`) | missing | Legacy duplicate |
| `12` (`Neutrino USD`) | missing | Legacy/distressed profile |

Count:

- `6` assets

These six are the main reason a credible path stops well short of 100.

## Realistic Coverage Targets

### Base case

Assume Pharos completes only the cleanest and most defensible work:

- all `9` current `low` assets upgraded to `medium`
- `2-4` of the cleaner missing assets added

Result:

- `84-86 / 100`

### Strong execution case

Assume:

- all `9` `low` assets upgraded
- `6-8` missing-but-fixable assets added

Result:

- `88-90 / 100`

### Stretch case

Assume:

- nearly all Bucket A lands
- one or more Bucket B methodology decisions go in favor of coverage

Result:

- `91-94 / 100`

### Non-credible case

To claim `100 / 100`, Pharos would likely need to:

- count legacy/cemetery assets as if they were active medium-confidence candidates, or
- stretch route semantics to cover assets whose redemption path is not actually demonstrated

That would weaken the product.

## Recommended Plan

## Phase 1: Clear all current `low` assets

Objective:

- move `9 / 9` current low-confidence top-100 assets to medium where justified

Assets:

- `usdd-tron-dao-reserve`
- `reusd-re-protocol`
- `usdf-astherus`
- `dusd-standx`
- `fpi-frax`
- `lisusd-lista`
- `usr-resolv`
- `msusd-main-street`
- `yusd-aegis`

Workstreams:

1. Placeholder-ratio remediation
   - `usdf-astherus`
   - `dusd-standx`
   - `usr-resolv`
   - `yusd-aegis`
   - `reusd-re-protocol`
2. Protocol-limit / adapter remediation
   - `usdd-tron-dao-reserve`
   - `lisusd-lista`
3. Semantics review
   - `fpi-frax`
   - `msusd-main-street`

Expected result:

- top-100 medium-or-better moves from `73` to `82`

## Phase 2: Add the cleanest missing assets

Objective:

- take the best missing names that look like curation/config gaps, not methodology dead ends

Priority order:

1. `214` (`USDX Money USDX`)
2. `pmusd-precious-metals`
3. `210` (`Elixir deUSD`)
4. `315` (`US Permissionless Dollar`)
5. `97` (`USP Stablecoin`)
6. `usdm-mega`

Workstreams:

1. canonical ID / asset curation
2. verify direct redemption route from primary docs
3. add config with reviewed docs and conservative bounded capacity

Expected result:

- top-100 medium-or-better moves from `82` to roughly `86-88`

## Phase 3: Tackle the technically harder DeFi missing set

Objective:

- close the remaining defensible gap without lowering standards

Assets:

- `susd-synthetix`
- `zchf-frankencoin`
- `mim-abracadabra`
- possibly `crvusd-curve`

Workstreams:

1. redemption semantics decision first
2. if credible, add route-family mapping
3. use existing reserve-source research where that helps support capacity claims

Expected result:

- top-100 medium-or-better reaches roughly `88-91`
- `91+` requires very strong outcomes in this phase

## Phase 4: Explicitly retire non-goals

Objective:

- stop the backlog from being distorted by low-value names

Assets to mark as non-goals unless new evidence appears:

- `153` (`Binance Peg BUSD`)
- `17` (`HUSD`)
- `21` (`FLEXUSD`)
- `328` (`Mustang Finance`)
- `4` (`Binance USD`)
- `12` (`Neutrino USD`)

Action:

- document them as legacy/cemetery/curation blockers for redemption coverage

This keeps the top-100 target honest and prevents endless churn trying to paper over weak names.

## Implementation Track Structure

I would run this as four tickets/workstreams rather than one broad effort.

### Track 1: Low-confidence remediation

Scope:

- all 9 `low` top-100 assets

Deliverable:

- `73 -> 82`

Why first:

- best guaranteed lift
- no curation ambiguity

### Track 2: Missing-asset curation and route onboarding

Scope:

- numeric-ID assets and unconfigured active names

Deliverable:

- `82 -> 86/88`

Why second:

- highest ROI among missing assets

### Track 3: DeFi semantics decisions

Scope:

- `sUSD`, `ZCHF`, `MIM`, `crvUSD`, `FRAX`

Deliverable:

- whatever is truly defensible, likely `+2` to `+5`

Why third:

- highest uncertainty
- methodology-sensitive

### Track 4: Legacy cleanup / explicit exclusions

Scope:

- BUSD variants, HUSD, FLEXUSD, USDN, similar

Deliverable:

- a stable denominator and a clear explanation of why 100 is not the right target

## Success Criteria

I would define success like this:

1. **Minimum success**
   - all current `low` top-100 assets resolved to either:
     - `medium`, or
     - explicit documented non-goal status
2. **Strong success**
   - `88+ / 100` top-100 medium-or-better coverage
3. **Methodology success**
   - no asset promoted to `medium` on a route that remains clearly heuristic or weakly evidenced

## Recommendation

The right planning target is:

- **Operational target:** `88 / 100`
- **Stretch target:** `90 / 100`
- **Do not commit to:** `100 / 100`

If the product wants literal `100 / 100`, that should be an explicit methodology decision:

- either lower the evidence bar, or
- redefine the top-100 denominator to exclude legacy/non-canonical assets

Without one of those changes, the honest path is "as close as realistically possible," not 100.
