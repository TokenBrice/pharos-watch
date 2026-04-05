# 2026-04-03 Stablecoin Issuer API Execution Plan

Companion research:
- `agents/research/2026-04-03-stablecoin-issuer-api-scan.md`

Goal:
- execute the highest-value uncovered issuer/API opportunities from the 2026-04-03 scan
- add the missing coverage first
- only upgrade existing routes when new live data materially improves fidelity instead of adding complexity for no scoring gain

## Objectives

1. Add the cleanest missing redemption-backstop rails with minimal policy churn.
2. Add the strongest reserve-sync candidates where the public surface is real, stable, and machine-readable enough to support hourly sync.
3. Reuse existing adapter families where the source shape honestly fits; add new adapter families only when at least two candidates justify the abstraction.
4. Avoid overstating evidence quality: dashboard-backed, scrape-backed, and on-chain proof surfaces must keep honest `sourceModel`, `evidenceClass`, freshness, and redemption-telemetry classifications.
5. Close the program with updated docs, counts, and regression coverage.

## Current Baseline

Coverage state at planning time:

- `176` active stablecoins
- `119` live reserve-enabled coins
- `57` active coins still missing live reserve support
- `144` configured redemption backstops
- `32` active coins still missing redemption backstop support

Important repo reality:

- `mxnb-juno` and `idrx-idrx` are true redemption gaps today.
- `usdz-anzen` is a true gap for both redemption and live reserves.
- `usdh-native-markets`, `usdm-moneta`, `usr-resolv`, and `cusd-cap` already have redemption-backstop coverage, so work there should focus on live reserves and optional fidelity upgrades.

## Candidate Prioritization

### Tier 1: ship now

These are the best ROI items because they either fill a real coverage hole or have a high-confidence public surface.

1. `mxnb-juno`
   - add redemption backstop
   - optionally evaluate transparency page for reserve telemetry in the same discovery pass
2. `idrx-idrx`
   - add redemption backstop
   - do not attempt live reserve sync in v1 unless a public reserve surface appears during endpoint discovery
3. `usdh-native-markets`
   - add live reserves if the transparency surface yields stable machine-readable data
   - keep current redemption route unless the new reserve surface exposes honest immediate-capacity telemetry
4. `usdz-anzen`
   - discovery for transparency-backed live reserves
   - add redemption only if official docs establish a reviewed direct issuer route clearly enough

### Tier 2: ship after Tier 1 passes

These are worthwhile, but either already have modeled redemption or are more complex technically.

1. `usr-resolv`
   - live reserve adapter from Apostro reserve surface if payload quality is stable
   - optional upgrade of current `10%` documented-bound backstop to `reserve-sync-metadata` if the surface exposes honest immediate buffer telemetry
2. `cusd-cap`
   - live reserve adapter only after browser/network inspection or an on-chain fallback path is confirmed
   - existing basket-redemption route is already acceptable until reserve telemetry is real
3. `usdm-moneta`
   - reserve/proof adapter only if a public HTTP or oracle-friendly feed can be used without building general Cardano indexing inside the worker

### Deferred / optional

1. `satusd-river`
   - not part of the core plan
   - revisit only after Tier 1 and Tier 2 because it is more likely to support route/quote telemetry than reserve sync

## Delivery Strategy

Split delivery into four phases:

- Phase A: source verification and acceptance gates
- Phase B: missing redemption coverage
- Phase C: reserve-sync additions
- Phase D: fidelity upgrades, docs, and closeout

Do not overlap Phase B and Phase C blindly. The main risk in this program is accidentally treating unstable transparency pages as first-class APIs.

## Success Criteria

Functional:

1. `mxnb-juno` and `idrx-idrx` have reviewed redemption-backstop coverage with explicit docs provenance.
2. At least two Tier 1 reserve candidates ship with honest live reserve support, or are explicitly rejected with documented reasons.
3. Any candidate promoted into `reserve-sync-metadata` has a real, repeatable source for `immediateRedeemable*` or stays on its documented-bound model.
4. `/api/stablecoin-reserves/:id`, `/api/redemption-backstops`, and stablecoin detail views remain contract-consistent.

Engineering:

1. Adapter choice remains minimal and evidence-driven.
2. No candidate relies on brittle bundle scraping without explicit fallback or monitoring notes.
3. Tests cover parse behavior, warning handling, stale-source behavior, and route resolution.

Documentation:

1. `docs/live-reserves.md` reflects new coverage counts and any new adapter family.
2. `docs/redemption-backstops.md` reflects new coverage counts and any route-family or confidence-model changes.
3. `docs/api-reference.md` is updated if response semantics materially change.
4. If methodology semantics change, update `/methodology` and the related version/timeline surface before merge.

## Constraints

- Keep changes minimal and root-cause driven.
- Preserve the current truth boundary between reviewed documented routes and live reserve telemetry.
- Do not introduce a broad generic "issuer API" abstraction before at least two candidates truly share the same payload and validation semantics.
- Respect existing live-reserve warning and evidence-class rules.
- Use `cmux browser` when direct fetches are blocked or when DOM/network inspection is required.
- Before pushing any branch, run `npm run test:merge-gate`.

## Phase A. Source Verification and Acceptance Gates

Objective:
- convert the research memo into implementation-grade source decisions
- reject candidates early when the public surface is not stable enough

Primary files:
- `agents/research/2026-04-03-stablecoin-issuer-api-scan.md`
- candidate metadata in `shared/data/stablecoins/*.json`
- reserve adapter implementations under `worker/src/cron/reserve-adapters/`
- `agents/process/cmux-browser.md` when browser inspection is required

Tasks:

1. For each candidate, classify the real source shape:
   - documented REST/OpenAPI
   - JSON page bootstrap
   - HTML table / attestation page
   - browser-only XHR feed
   - on-chain/oracle proof
   - no public machine-readable source
2. Record exact fetch requirements:
   - public vs auth-gated
   - rate limits if published
   - anti-bot behavior
   - timestamp/freshness semantics
   - payload invariance by coin vs per-coin
3. Apply go/no-go gates:
   - `go` only if the source is public, repeatable, and parsable without fragile session state
   - `defer` if browser-only but stable XHR can likely be extracted
   - `reject` if auth-gated, unstable, or only human-readable PDFs/assets are exposed
4. Save candidate-specific probe notes in `agents/` only when implementation work would otherwise lose context.

Acceptance criteria:

- each Tier 1/Tier 2 candidate has one explicit execution lane:
  - `redemption-only`
  - `live-reserves-only`
  - `both`
  - `defer`
  - `reject`

## Candidate Execution Matrix

| Candidate | Current state | Planned lane | Expected implementation shape |
| --- | --- | --- | --- |
| `mxnb-juno` | no redemption, no live reserves | Phase B primary | add `offchain-issuer` redemption route; optional reserve follow-up only if transparency page is easy |
| `idrx-idrx` | no redemption, no live reserves | Phase B primary | add `offchain-issuer` redemption route from current API docs/index |
| `usdh-native-markets` | redemption exists, no live reserves | Phase C primary | add live reserve adapter if transparency/dashboard payload is stable; consider reserve-backed redemption upgrade later |
| `usdz-anzen` | no redemption, no live reserves | Phase A gate, then C or B+C | likely live reserves first; redemption only if docs prove direct issuer route cleanly |
| `usr-resolv` | redemption exists, no live reserves | Phase C secondary | add live reserve adapter; optionally upgrade redemption capacity if immediate stable buffer is measurable |
| `cusd-cap` | redemption exists, no live reserves | Phase C secondary | browser/network inspection first; use HTTP or on-chain adapter depending source shape |
| `usdm-moneta` | redemption exists, no live reserves | Phase C secondary | prefer public proof/oracle adapter; avoid general Cardano indexing in first tranche |

## Phase B. Missing Redemption Coverage

Objective:
- close the easiest real coverage gaps before reserve-adapter work

Primary files:
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstops.ts`
- `shared/lib/redemption-backstop-version.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`
- relevant tests under:
  - `shared/lib/__tests__/redemption-backstops.test.ts`
  - `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
  - `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
  - `worker/src/api/__tests__/redemption-backstops.test.ts`

### W1. `mxnb-juno`

Plan:

1. Add `mxnb-juno` to `OFFCHAIN_ISSUER_BACKSTOP_CONFIGS`.
2. Start conservative:
   - `issuerBase`
   - reviewed direct redemption or documented-bound full-supply semantics only if Juno docs explicitly support it
   - variable or undisclosed-reviewed fee model unless docs provide a bounded fee
3. Use reviewed docs provenance from:
   - current Juno conversion docs
   - any issuer redemption or stablecoin infrastructure docs needed to support access/capacity/fees
4. Add route notes if access is restricted to verified or institutional users.

Go/no-go:

- if Juno docs clearly support direct MXNB issuer redemption/conversion, ship
- if docs only support partner/institution conversions without clear holder redemption semantics, keep route but reduce access/capacity confidence honestly

### W2. `idrx-idrx`

Plan:

1. Add `idrx-idrx` to `OFFCHAIN_ISSUER_BACKSTOP_CONFIGS`.
2. Resolve the current docs/API spec entrypoint first, because old deep links have churned.
3. Treat the route as API-backed issuer redemption, but do not claim a fixed fee unless the current docs or spec publishes one.
4. Add explicit notes if:
   - settlement is manual or business-day bounded
   - KYC or whitelisting meaningfully affects access
   - limits or max ticket sizes apply

Go/no-go:

- ship once the current docs index or spec confirms redeem request support and enough route semantics for review
- do not block on reserve discovery

### W3. Optional `usdz-anzen` redemption addition

Only do this in Phase B if the docs review uncovers a direct, holder-relevant issuer redemption rail. Otherwise defer redemption and focus on live reserves first.

## Phase C. Reserve-Sync Additions

Objective:
- add live reserves only where the source shape supports honest hourly sync

Primary files:
- `shared/lib/live-reserve-adapters.ts`
- `shared/types/live-reserves.ts`
- candidate metadata in `shared/data/stablecoins/*.json`
- new or updated adapters under `worker/src/cron/reserve-adapters/`
- live-reserve tests under:
  - `worker/src/cron/reserve-adapters/__tests__/`
  - `worker/src/cron/__tests__/sync-live-reserves.test.ts`
  - `worker/src/api/__tests__/stablecoin-reserves.test.ts`
  - `src/hooks/__tests__/use-stablecoin-reserves.test.ts`
  - `src/components/__tests__/overview-section.test.tsx`
- docs:
  - `docs/live-reserves.md`
  - `docs/api-reference.md`

### Adapter decision rule

Use the smallest honest shape that fits:

1. Reuse an existing adapter if the candidate truly matches its source semantics.
2. Add a new targeted adapter if the candidate needs custom parsing but not a new family abstraction.
3. Add a reusable adapter family only when at least two shipped candidates share:
   - payload shape
   - freshness semantics
   - reserve semantics
   - validation rules
   - redemption telemetry behavior

### W4. `usdh-native-markets`

Preferred outcome:
- live reserve sync from the transparency page or its backing JSON/XHR payload

Execution steps:

1. Inspect `https://www.usdh.com/transparency` in a browser.
2. Determine whether the page exposes:
   - total reserve USD
   - liability/supply
   - reserve composition
   - disclosure timestamp
   - immediate redeemable amount or a trustworthy proxy
3. Choose implementation:
   - if the page exposes a stable JSON feed with one bucket: `single-bucket`-style adapter or a small new disclosure adapter
   - if the page exposes composition slices: `dynamic-mix` adapter
4. Add `liveReservesConfig` to `usdh-native-markets`.
5. Only change redemption to `reserve-sync-metadata` if the live feed exposes real immediate-capacity telemetry. Otherwise keep the current reviewed direct route.

Target semantics:

- reserve mode likely `attestation-mix` or `single-asset`, depending payload
- evidence class depends on source quality; do not force `independent` if this is only a coarse attestation page

### W5. `usdz-anzen`

Preferred outcome:
- live reserve sync from `rwa.anzen.finance/transparency`

Execution steps:

1. Inspect the transparency page and its XHR/bootstrap data.
2. Determine whether the surface supports:
   - one-bucket collateral totals
   - composition slices
   - source timestamp
   - reserve/supply ratio
3. If machine-readable and stable, implement live reserves.
4. If the surface is only HTML but stable, allow a scrape-backed adapter with strict validation and warning behavior.
5. If the transparency surface is too brittle, defer instead of shipping a fragile parser.

Optional follow-up:

- if docs separately establish a reviewed issuer redemption rail, add the redemption config in the same tranche

### W6. `usr-resolv`

Preferred outcome:
- live reserve sync from Apostro reserve data

Execution steps:

1. Inspect the reserve dashboard/network payload behind `info.apostro.xyz/resolv-reserves`.
2. Map the payload to current Pharos reserve semantics:
   - cash / stables buffer
   - strategy or hedge legs
   - unknown / unmapped exposure
3. Start with reserve detail fidelity first.
4. Upgrade the existing `usr-resolv` redemption route only if the live feed exposes a genuine immediate stablecoin buffer or redeemable-capacity bound.

Important constraint:

- do not replace the current reviewed `10%` documented-bound route with a live model unless the live telemetry is clearly stronger

### W7. `cusd-cap`

Preferred outcome:
- live reserve sync if the reserve page or on-chain vault state is accessible enough

Execution steps:

1. Use browser inspection on `https://cap.app/vault/reserves/cUSD` because direct fetch is blocked.
2. Decide between:
   - hidden XHR/API payload
   - page bootstrap JSON
   - on-chain vault/oracle reads
3. If the HTTP surface is still blocked or too brittle, switch to on-chain implementation planning rather than scraping harder.
4. Keep the current basket-redemption model unless reserve telemetry proves an honest current redeemable bound.

Go/no-go:

- if only session-bound or bot-blocked data exists, defer HTTP ingestion
- prefer on-chain over brittle browser-only scraping

### W8. `usdm-moneta`

Preferred outcome:
- reserve/proof adapter that avoids building broad Cardano infrastructure in this tranche

Execution steps:

1. Start from the existing `proofOfReserves.url` in metadata:
   - `https://portal.charli3.io/dev/feeds/usdm-reserves?network=Mainnet`
2. Verify whether Charli3 exposes:
   - a public JSON payload
   - timestamped reserve values
   - reserve/supply ratio or reserve total
3. If yes, implement a narrow proof adapter.
4. If not, defer until a Moneta or Charli3 surface can be integrated without general Cardano chain indexing.

Important constraint:

- Cardano-native custom indexing is out of scope for the first tranche unless the rest of Tier 1 is already done and the feed is materially better than the HTTP proof path

## Phase D. Fidelity Upgrades, Docs, and Closeout

Objective:
- integrate live reserve telemetry back into redemption only where it genuinely upgrades the route
- close the documentation and validation loop

Primary files:
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `shared/lib/redemption-backstop-configs/*`
- `shared/lib/redemption-backstop-version.ts`
- `docs/redemption-backstops.md`
- `docs/live-reserves.md`
- `docs/api-reference.md`
- methodology surfaces if scoring semantics change

Tasks:

1. For `usdh-native-markets`, `usr-resolv`, and `cusd-cap`, decide whether new reserve telemetry is strong enough to change the current redemption capacity model.
2. Promote to `reserve-sync-metadata` only when:
   - the adapter declares real capacity telemetry
   - freshness is scoring-eligible
   - the live metric is stronger than the existing reviewed documented-bound route
3. Leave existing documented-bound models in place when the live feed is only coarse solvency proof.
4. Update coverage counts and adapter counts in docs.
5. If any new adapter introduces a new semantics or evidence-class story, update the methodology surface as required by AGENTS.

## Workstream Order

Recommended order:

1. `mxnb-juno` redemption
2. `idrx-idrx` redemption
3. `usdh-native-markets` reserve discovery and implementation
4. `usdz-anzen` reserve discovery and implementation
5. `usr-resolv` reserve implementation
6. `cusd-cap` reserve implementation
7. `usdm-moneta` proof/reserve implementation
8. redemption fidelity upgrades from newly shipped reserve telemetry
9. docs, counts, and merge gate

Reason:

- the first two steps close real coverage holes quickly
- the next two validate whether transparency-page reserve ingestion is viable without major new abstractions
- later candidates are either harder or already partially covered

## Expected File Touchpoints

### Redemption tranche

- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-version.ts`
- `shared/lib/__tests__/redemption-backstops.test.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `worker/src/api/__tests__/redemption-backstops.test.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`

### Live reserve tranche

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `shared/data/stablecoins/non-usd.json`
- `shared/lib/live-reserve-adapters.ts`
- `shared/types/live-reserves.ts`
- `worker/src/cron/reserve-adapters/index.ts`
- one or more of:
  - `worker/src/cron/reserve-adapters/<candidate>.ts`
  - `worker/src/cron/reserve-adapters/<shared-family>.ts`
- matching tests under `worker/src/cron/reserve-adapters/__tests__/`
- `worker/src/cron/__tests__/sync-live-reserves.test.ts`
- `worker/src/api/__tests__/stablecoin-reserves.test.ts`
- `src/hooks/__tests__/use-stablecoin-reserves.test.ts`
- `src/components/__tests__/overview-section.test.tsx`
- `docs/live-reserves.md`
- `docs/api-reference.md`

## Validation Plan

Run candidate-local validation during each tranche, then full merge gate before push.

### Redemption-focused tranche

```bash
npx vitest run \
  shared/lib/__tests__/redemption-backstops.test.ts \
  shared/lib/__tests__/redemption-backstop-consistency.test.ts \
  worker/src/cron/__tests__/sync-redemption-backstops.test.ts \
  worker/src/api/__tests__/redemption-backstops.test.ts
```

### Live-reserve tranche

```bash
npx vitest run \
  worker/src/cron/__tests__/sync-live-reserves.test.ts \
  worker/src/api/__tests__/stablecoin-reserves.test.ts \
  src/hooks/__tests__/use-stablecoin-reserves.test.ts \
  src/components/__tests__/overview-section.test.tsx
```

Add candidate-specific adapter tests as each adapter lands.

### Full repo validation before push

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
npm run test:merge-gate
```

## Risks and Mitigations

### Risk: transparency page exists, but the real data is bundle-private or brittle

Mitigation:

- inspect network calls first
- prefer stable XHR/bootstrap JSON
- defer if the only path is fragile DOM scraping

### Risk: reserve telemetry looks useful, but does not improve redemption truthfulness

Mitigation:

- only promote redemption routes to `reserve-sync-metadata` when telemetry is stronger than the current reviewed model
- otherwise keep reserve sync and redemption modeling separate

### Risk: Cardano integration for `usdm-moneta` becomes a project of its own

Mitigation:

- require a public HTTP or oracle-friendly proof surface for tranche one
- defer broader Cardano indexing

### Risk: adapter abstraction grows faster than coverage

Mitigation:

- build one-off adapters first when source semantics differ materially
- only generalize after the second real use case ships

### Risk: docs drift from counts and semantics

Mitigation:

- treat docs updates as part of each merged tranche
- re-run counts from the actual registry/config state before final closeout

## Exit Conditions

The plan is complete when:

1. `mxnb-juno` and `idrx-idrx` are covered in redemption backstops.
2. At least two of `usdh-native-markets`, `usdz-anzen`, `usr-resolv`, `cusd-cap`, `usdm-moneta` ship with live reserves, or are explicitly rejected with documented reasons.
3. Any reserve-backed redemption upgrade is supported by real telemetry rather than optimism.
4. Coverage docs and API docs match the shipped system exactly.
