# Redemption Backstop Top-100 Medium-Coverage Execution Backlog

Date: 2026-03-24

## Target

Working target:

- move top-100 Redemption Backstop medium-or-better coverage from `73 / 100` to `88 / 100`

Strategy:

1. clear all `9` current `low` assets if they can be defended at `medium`
2. convert at least `6` current `missing` assets that look like genuine onboarding gaps rather than cemetery/legacy noise

That path gets to:

- `73 + 9 + 6 = 88`

This backlog is ordered for that outcome.

## Current Gap

### Current `low` top-100 assets

| Asset | MCap | Current issue |
| --- | ---: | --- |
| `USDD` | `$1.173B` | heuristic PSM ratio |
| `reUSD` | `$0.183B` | heuristic queue ratio |
| `USDF` (`Astherus`) | `$0.125B` | placeholder `15%` ratio |
| `DUSD` (`StandX`) | `$0.100B` | placeholder `15%` ratio |
| `FPI` | `$0.097B` | route modeled, but still heuristic |
| `LISUSD` | `$0.076B` | heuristic ratio despite published daily limit |
| `USR` | `$0.046B` | placeholder `15%` ratio |
| `MSUSD` | `$0.042B` | generic supply-full heuristic |
| `YUSD` | `$0.038B` | placeholder `15%` ratio |

### Best `missing` candidates for the `88 / 100` path

| Asset | MCap | Why it is in-scope |
| --- | ---: | --- |
| `USDX` (`id=214`) | `$0.683B` | large active name, likely curation/config issue |
| `pmUSD` | `$0.100B` | internal research already flags live dashboard / issuer source path |
| `DEUSD` (`id=210`) | `$0.092B` | likely route-onboarding candidate |
| `USPD` (`id=315`) | `$0.099B` | likely route-onboarding candidate |
| `USP` (`id=97`) | `$0.065B` | likely route-onboarding candidate |
| `USDM` (`MegaUSD`) | `$0.062B` | already present in metadata research corpus |

These six are the cleanest set to hit `88 / 100` without depending on the harder DeFi semantics cases.

## Execution Order

## Wave 1: Clear the 9 current `low` names

Expected lift:

- `73 -> 82`

Reason to do this first:

- highest certainty
- no denominator debates
- each win is visible immediately in the top-100 score

### Ticket 1: USDD live-capacity replacement

Asset:

- `usdd-tron-dao-reserve`

Goal:

- move `low -> medium`

Why this is first:

- biggest single low-confidence gap by market cap

Scope:

- replace the current heuristic `0.16` PSM ratio with a bounded live/data-backed capacity model
- reuse the existing research that identified USDD as a transparency/adaptation problem rather than a docs problem

Likely files:

- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- `worker/src/cron/reserve-adapters/*`
- `worker/src/lib/redemption-backstop-sources.ts`
- relevant tests

Risk:

- TRON/non-EVM integration may be larger than one ticket

Fallback definition of done:

- reviewed documented-bound model that is stronger than the current heuristic ratio, if a live adapter is not ready

### Ticket 2: Placeholder-ratio batch A

Assets:

- `reusd-re-protocol`
- `usr-resolv`
- `yusd-aegis`

Goal:

- move all three from `low -> medium`

Why grouped:

- all are strategy-backed or queue/buffer-driven names where the main issue is missing liquid-buffer evidence
- internal research already points to transparency/dashboard sources

Scope:

- review whether existing public dashboards can support `documented-bound`
- where possible, expose or ingest redemption-relevant liquid-buffer metadata
- eliminate blind heuristic ratios

Likely files:

- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `worker/src/cron/reserve-adapters/*`
- `worker/src/lib/redemption-backstop-live-metadata.ts`

Expected lift:

- `+3`

### Ticket 3: Placeholder-ratio batch B

Assets:

- `usdf-astherus`
- `dusd-standx`

Goal:

- move both from `low -> medium`

Why grouped:

- both currently advertise explicit "pending protocol-specific liquidity research" style placeholder ratios
- they are the clearest evidence-quality debt in the current configs

Scope:

- review issuer/protocol docs and any public transparency surface
- determine whether each can be promoted to `documented-bound`
- if not, decide whether they remain low or should lose coverage entirely

Important guardrail:

- this ticket is not "find a nicer heuristic"
- it is "replace the heuristic with defensible evidence or keep it out"

Expected lift:

- `+1` to `+2`
- target `+2`

### Ticket 4: LISUSD capacity-model correction

Asset:

- `lisusd-lista`

Goal:

- move `low -> medium`

Why separate:

- unlike the placeholder group, LISUSD already has published fee and daily-limit data
- the issue is model shape, not complete evidence absence

Scope:

- decide whether the daily redemption limit should produce:
  - a documented bounded ratio
  - an absolute-capacity-backed score path
  - or a live BNB-chain adapter if needed

Likely files:

- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- scoring/capacity resolution if absolute-cap support is needed

Expected lift:

- `+1`

### Ticket 5: FPI and MSUSD semantics review

Assets:

- `fpi-frax`
- `msusd-main-street`

Goal:

- decide whether each can honestly be `medium`

Why separate:

- both are methodology questions before they are implementation questions
- `FPI` especially may simply not belong in the "medium-confidence backstop" set

Scope:

- review whether the current modeled redemption rail is genuinely comparable to the rest of the module
- if yes, promote with reviewed docs / documented-bound semantics
- if no, explicitly record as non-goal instead of forcing the score upward

Expected lift:

- realistic `+1`
- stretch `+2`

## Wave 2: Add the 6 missing names needed for `88 / 100`

Expected lift:

- `82 -> 88`

Reason to do this second:

- these are the best missing-asset ROI set
- avoids spending early time on difficult DeFi semantics cases that are not required for the `88` target

### Ticket 6: Numeric-ID curation batch

Assets:

- `214` (`USDX Money USDX`)
- `210` (`Elixir deUSD`)
- `315` (`US Permissionless Dollar`)
- `97` (`USP Stablecoin`)

Goal:

- determine which of these are legitimate active top-100 names that deserve canonical tracked IDs and route configs

Deliverables:

1. canonical ID decision
2. cemetery/legacy exclusion decision if applicable
3. redemption route config for the survivors

Why this is one batch:

- the biggest risk is asset-catalog inconsistency, not route modeling
- resolve that once instead of piecemeal

Expected lift:

- realistic `+2` to `+4`
- planning target `+3`

### Ticket 7: pmUSD onboarding

Asset:

- `pmusd-precious-metals`

Goal:

- add medium-confidence redemption coverage if issuer docs support it

Why separate:

- unlike the numeric IDs, pmUSD already looks like a normal tracked asset with internal source research
- likely an issuer-style onboarding task

Scope:

- review issuer redemption docs / dashboard
- decide between `offchain-issuer` and commodity-style issuer treatment
- add conservative documented-bound config if credible

Expected lift:

- `+1`

### Ticket 8: MegaUSD onboarding

Asset:

- `usdm-mega`

Goal:

- determine whether MegaUSD has a credible direct redemption rail and add coverage if yes

Why separate:

- already in the metadata corpus
- internal reserve research called it a strong live/dashboard candidate

Expected lift:

- `+1`

## Wave 3: Stretch beyond 88

These are the next tickets after the target is already met or nearly met.

### Ticket 9: DeFi missing-set semantics batch

Assets:

- `susd-synthetix`
- `zchf-frankencoin`
- `mim-abracadabra`

Goal:

- move the strongest subset to `medium`

Why deferred:

- these are the highest-uncertainty names
- each may require a deeper methodology decision

Expected lift:

- realistic `+1` to `+3`

### Ticket 10: Explicit non-goal cleanup

Assets:

- `153` (`Binance Peg BUSD`)
- `17` (`HUSD`)
- `21` (`FLEXUSD`)
- `328` (`Mustang Finance`)
- `4` (`Binance USD`)
- `12` (`Neutrino USD`)

Goal:

- explicitly document why these are excluded from the realistic medium-coverage plan

Why this matters:

- prevents the team from chasing misleading "100/100" pressure

## Coverage Math

### Conservative path

- Wave 1: `+7`
- Wave 2: `+4`

Result:

- `84 / 100`

### Target path

- Wave 1: `+9`
- Wave 2: `+6`

Result:

- `88 / 100`

### Stretch path

- Wave 1: `+9`
- Wave 2: `+6`
- Wave 3: `+2`

Result:

- `90 / 100`

## Recommended Sprint Breakdown

## Sprint A

Tickets:

- Ticket 1: `USDD`
- Ticket 2: placeholder-ratio batch A
- Ticket 4: `LISUSD`

Expected impact:

- best chance to move quickly from `73` into the high `70s`

## Sprint B

Tickets:

- Ticket 3: placeholder-ratio batch B
- Ticket 5: `FPI` / `MSUSD`
- Ticket 6: numeric-ID curation batch

Expected impact:

- should finish the `low` cleanup and unlock several missing names

## Sprint C

Tickets:

- Ticket 7: `pmUSD`
- Ticket 8: `MegaUSD`
- Ticket 9: DeFi missing-set semantics batch

Expected impact:

- gets the team through `88 / 100` and possibly into stretch territory

## Success Criteria

1. All current `low` top-100 assets have a final explicit state:
   - promoted to `medium`, or
   - intentionally removed / documented as non-goal
2. At least `6` current `missing` top-100 assets are resolved into:
   - medium-confidence coverage, or
   - explicit exclusion with rationale
3. No route is promoted on the basis of an unreviewed placeholder ratio
4. The public methodology story remains honest

## Recommended Start

If the team wants the fastest path to visible progress, start with:

1. `USDD`
2. `reUSD` + `USR` + `YUSD`
3. `LISUSD`
4. numeric-ID curation batch

That sequence gives the best shot at reaching `88 / 100` without first getting stuck in the harder DeFi semantics backlog.
