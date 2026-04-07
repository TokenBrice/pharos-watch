# NAV Wrapper Peg-Reference Plan

## Problem

`computeOverallGrade()` treats `pegStability = NR` as a neutral 1.0 multiplier for `navToken` assets. After the peg multiplier exponent was raised to `0.4`, pegged assets with imperfect peg scores are penalized harder while NAV wrappers with no peg score avoid that penalty entirely.

Observed live example on 2026-04-06:

- `usdai-usd-ai`: base score `69.6`, peg score `82`, overall `64`
- `susdai-usd-ai`: base score `65.5`, peg score `NR`, overall `66`

That is backwards for a NAV wrapper whose redemption path still exits through the base stablecoin.

## Design

1. Add an optional metadata field for NAV wrappers to declare a peg-reference stablecoin id.
2. When a nav token has no direct peg score but does have a configured peg reference, inherit peg scoring and active-depeg caps from the referenced stablecoin.
3. Keep genuine NAV fund-share tokens without a peg reference neutral; they are not supposed to track `$1`.
4. Use the inherited peg score only for overall grade and the peg-stability dimension. Dependency and reserve scoring stay unchanged.

## Initial Scope

- Configure `susdai-usd-ai -> usdai-usd-ai`
- Leave other nav tokens unchanged unless they have a clearly reviewed base-token reference

## Docs / Validation

- Update `docs/report-cards.md`
- Update `docs/report-cards-timeline.md`
- Update `/methodology` Safety Scores section + scoring changelog/version entry
- Update `docs/api-reference.md` if `RawDimensionInputs` changes
- Validate with targeted report-card tests, lint, build, and worker typecheck
