# Custody And Collateral Labels

`collateralQuality` and whole-book `custodyModel` are scalar labels in the base coin file. Valid values: `CUSTODY_MODEL_VALUES` in `shared/types/custody.ts` and `CollateralQualitySchema` in `shared/types/reserves.ts`; the source files win over any list quoted elsewhere.

## What The Labels Drive

Selector custody eligibility (`shared/lib/selector/`), DDR verdict signals (`shared/lib/depeg-resolver/`), Screener filters, the detail-page custody module, Compare, and the fallback reserve templates in `shared/lib/reserve-templates.ts`. They do not feed the Safety Score: never promise or expect a grade change from a label edit.

## Read First

- `resolveCustodyModel()` in `shared/lib/report-card-policy.ts`: an authored value wins; omission resolves by structural class, not to a universal unknown.
- The `custodyModel` rule in [Editing Rules](../../../../docs/stablecoin-data.md#editing-rules) and [When to override resilience/decentralization fields](../../../../docs/process/adding-a-stablecoin.md#when-to-override-resiliencedecentralization-fields).
- The reserves sidecar `shared/data/stablecoins/domains/reserves/<id>.json`: slices and `custodyProfile` are the evidence behind both labels.

## Classify

1. Review every material backing and custody layer. Backing and governance flags alone establish no affirmative custody tier.
2. Treat these as mismatch signals worth research: off-chain or exchange custody, bridge-heavy collateral, delta-neutral or structured strategies, and custodian or bridge names in `collateral` prose.
3. Research official docs plus one independent source when the architecture is not obvious.
4. `collateralQuality`: classify by the riskiest significant backing component.
5. `custodyModel`: claim a tier only when evidence covers every material backing part. Use `mixed` for evidenced heterogeneous custody and `unknown` when whole-book coverage is unestablished; author either explicitly when the omission default would overstate the evidence.

## Decision Rules

- A predominant verified custodian cannot establish an asset-wide institutional label.
- Do not turn an undisclosed regulator into proven unregulated custody, or a mixed book into all-onchain custody.
- A mechanism name proves nothing: a delta-neutral design can combine institutional, exchange and issuer-controlled wallets.
- Keep partial providers, unknown shares and legal safeguards in `custodyProfile`, not in the scalar label.

## Apply And Verify

Apply sourced labels in the base coin file with a minimal diff, only when approved. Then run `npm run bootstrap:generated`, `npm run check:stablecoin-data` and `npx vitest run shared/lib/__tests__/report-card-policy.test.ts`; in a coordinated addition, return evidence and changed paths in the [handoff packet](../../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet) instead.
