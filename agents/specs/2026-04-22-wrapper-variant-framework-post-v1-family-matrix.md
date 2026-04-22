# Wrapper Variant Post-V1 Family Matrix

Date: 2026-04-22
Status: Approved for Phase 4B implementation
Source plan: `agents/plans/2026-04-22-wrapper-variant-framework-follow-up-implementation-plan.md` Phase 4A

## Goal

Classify the deferred non-v1 assets into explicit post-v1 families, choose one family that is safe to implement now, and record non-goals for everything else.

## Family Definitions

### `bond-maturity`

- Product: fixed-notional bond or locked-maturity wrapper over a tracked parent stablecoin
- Peg treatment: parent-linked in this implementation phase; maturity-aware fair-value modeling stays deferred
- Dependency semantics: synthetic parent `wrapper` edge plus a stricter dependency ceiling than v1 wrappers
- Overall cap: cannot outscore the parent overall card
- Yield ownership: child-owned when the bond product itself emits the coupon stream
- UI label: `Bond`

### `strategy-vault`

- Product: active strategy vault over a tracked parent stablecoin
- Peg treatment: requires explicit NAV/fair-value work before safe public scoring changes
- Dependency semantics: parent relationship plus independent strategy risk
- Overall cap: parent-capped, but only after the vault-specific peg/liquidity/resilience rules are settled
- Yield ownership: usually child-owned
- UI label: `Strategy`

### `anchor-asset-vault`

- Product: vault or strategy token over USDC / USDT or another tracked fiat anchor, but not a true product child of the anchor issuer
- Peg treatment: anchor-asset aware, not true parent-child variant inheritance
- Dependency semantics: explicit upstream anchor exposure without overloading `variantOf`
- Overall cap: deferred
- Yield ownership: child-owned
- UI label: deferred

## Asset Matrix

| Asset | Family | Decision |
| --- | --- | --- |
| `busd0-usual` | `bond-maturity` | **Implement now** |
| `susdai-usd-ai` | `strategy-vault` | defer |
| `msy-main-street` | `strategy-vault` | defer |
| `stcusd-cap` | `strategy-vault` | defer |
| `said-gaib` | `strategy-vault` | defer |
| `sbold-k3-capital` | `strategy-vault` | defer pending clearer risk-primary semantics |
| `yusd-yieldfi` | `anchor-asset-vault` | defer |
| `syrupusdc-maple` | `anchor-asset-vault` | defer |
| `syrupusdt-maple` | `anchor-asset-vault` | defer |

## Why `bond-maturity` Is The Phase 4B Family

- one tracked asset (`busd0-usual`) carries the family, so rollout blast radius is narrow
- the parent is already a tracked stablecoin (`usd0-usual`)
- no yield-history ownership migration is required
- the family broadens the framework beyond the two v1 kinds without forcing the unresolved anchor-asset or full NAV/fair-value design

## Phase 4B Contract

### Asset in scope

- `busd0-usual`

### Metadata

- add `variantOf: "usd0-usual"`
- add `variantKind: "bond-maturity"`
- keep `pegReferenceId: "usd0-usual"` in this phase

### Scoring

- dependency-risk wrapper penalty: `parent - 8`
- overall score remains capped to the parent as with other tracked variants
- no maturity-floor or discount-to-maturity peg model ships in this phase

### Browse / UI

- expose `Bond` as a first-class variant label alongside existing variant labels
- allow the homepage variant owner to filter bond variants through the same `variant` query param
- show bond variants in the same parent/child relationship surfaces as v1 variants

### Docs / versioning

- Safety Score methodology version bumps numerically in the same PR
- homepage/detail/api/route-inventory docs update in the same PR

## Explicit Non-Goals

- no dedicated `/stablecoins/variants/*` route family
- no anchor-asset vault implementation
- no strategy-vault implementation
- no maturity-aware price floor or `rt-bUSD0` instrument modeling
- no `pegReferenceId` stripping for the other deferred families
