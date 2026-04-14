# USR Redemption Backstop Failure Analysis - 2026-04-14

## Scope

Analyze why `usr-resolv` still showed a strong redemption backstop (`82/100`, effective exit `85/100`) during a severe active depeg, and identify general redemption-backstop methodology changes that would prevent similar failures without applying a one-off USR fix.

## Current production facts checked

- `GET https://pharos.watch/_site-data/redemption-backstops` returned `usr-resolv` with:
  - `score: 82`
  - `effectiveExitScore: 85`
  - `dexLiquidityScore: 33`
  - `modelConfidence: medium`
  - `resolutionState: resolved`
  - route components: `stablecoin-redeem`, `permissionless-onchain`, `atomic`, `deterministic-onchain`, `stable-single`
  - `immediateCapacityRatio: 0.1`, `immediateCapacityUsd: 2,296,296.78`
- `GET https://pharos.watch/_site-data/peg-summary` returned `usr-resolv` with:
  - `pegScore: 0`
  - `activeDepeg: true`
  - `currentDeviationBps: -8332`
  - `priceObservedAt: 2026-04-14 05:15:46 UTC`
  - consensus sources: CoinGecko, DefiLlama list, Pyth, DEX promoted
- `GET https://pharos.watch/_site-data/depeg-events?stablecoin=usr-resolv&active=true` returned an active below-peg event starting `2026-03-22 02:04:57 UTC`, with peak deviation `-9025 bps` and peak price `0.09753741`.
- CoinGecko showed USR around `$0.1687`, a visible exploit notice, 24h range `$0.1639-$0.1690`, and an all-time low of `$0.09773` on `2026-04-03`.
- DefiLlama stablecoins API showed Resolv USD at approximately `$0.1667`.

## Primary source facts checked

- Resolv's current website includes an important notice saying the team is investigating a security incident involving unauthorized USR minting and that the collateral pool remains intact.
- Resolv's April 4, 2026 postmortem says:
  - The March 22 incident minted `80M USR` illicitly and extracted approximately `$25M` in ETH.
  - Most protocol operations were paused.
  - Approximately `46M USR` of illicitly minted supply had been neutralized.
  - Pre-hack USR holders were being compensated `1:1`; most redemptions were already processed or in the pipeline.
  - The company was evaluating the impact on other affected parties, and most operations remained paused until further notice.
- Resolv Terms of Service say direct purchase/redemption requires verified RDAL customer status, redemptions may take several business days, RDAL can delay redemptions when collateral is unavailable/illiquid/lost or for legal/government reasons, and the Resolv Parties may delay or suspend redemption in several circumstances.
- The official app bundle currently contains a temporary-unavailable state warning users not to trade or interact with Resolv assets and a redemption-portal path. The `api.resolv.xyz` redemption max-redeem endpoint returned `503`, while `web-api.resolv.xyz` returned no healthy upstream during the spot check. Treat this as supporting operational evidence, not methodology-grade primary evidence, because the bundle is not a stable documented API.

## Why the current model failed

The current backstop score is a static route-capability score, not a current exercisability score. For USR, the configured route is:

```ts
"usr-resolv": {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  reviewedAt: "2026-03-23",
  docs: [
    sourceRef("Resolv docs", "https://docs.resolv.xyz/", ["route", "capacity"]),
    sourceRef("Resolv Apostro reserves", "https://info.apostro.xyz/resolv-reserves", ["capacity"]),
  ],
}
```

`stablecoinRedeemBase` contributes very high static route components:

- access `permissionless-onchain` = `100`
- settlement `atomic` = `100`
- execution `deterministic-onchain` = `100`
- output asset `stable-single` = `100`

The 10% capacity ratio produces capacity score `53`, and the unknown fee model produces cost score `40`. The weighted score is therefore:

```text
100*0.20 + 100*0.15 + 100*0.15 + 53*0.25 + 100*0.15 + 40*0.10 = 82.25 -> 82
```

The v3.7 effective-exit formula then produces:

```text
max(33, 82) + min(33, 82)*0.10 = 85.3 -> 85
```

This is mechanically consistent with the current scoring code, but semantically wrong under the current facts because the score is allowed to ignore live market/incident evidence that the route is not broadly exercisable at par.

## Specific weaknesses exposed by USR

1. Static route terms overrode live exercisability.
   The route was scored from docs reviewed on March 23, while Resolv's April 4 postmortem says most operations are paused and only pre-hack holders were being compensated or processed. The module has no `routeStatus` or `redemptionCurrentlyOpen` gate.

2. Access was mis-modeled.
   The config inherited `permissionless-onchain`, but Resolv's Terms of Service say direct redemption is for verified RDAL customers and can be delayed or suspended. Even before the exploit, that is closer to whitelisted/issuer-mediated access than permissionless atomic access.

3. Settlement was mis-modeled.
   The config inherited `atomic`, but Resolv's legal terms say redemptions may take several business days and can be delayed. The post-incident path is explicitly not normal atomic redemption.

4. Capacity evidence was stale and eligibility-blind.
   The 10% static bound reflected a curated USD-stablecoin buffer. During an exploit, the relevant question is not only "does a buffer exist?" but "who can use it, against which supply cohort, and whether the protocol is currently accepting generic holder requests."

5. No peg-consistency circuit breaker.
   A persistent 80%+ depeg with multiple strong price sources is strong negative evidence that redemption at or near par is not generally available. The redemption module currently does not consume peg/depeg state, and report cards only use peg state for the peg dimension and overall cap, not for redemption route eligibility.

6. Medium-confidence eligibility is too permissive.
   Report cards exclude only low-confidence redemption routes from liquidity uplift. USR's `documented-bound` capacity makes the route medium confidence, so the failed backstop uplifts the liquidity dimension to `A` even when the peg dimension is `F`.

## Suggested general enhancements

### 1. Add a route availability / exercisability layer

Extend the entry model with a current route state that can be evaluated independently from static route shape:

```ts
routeStatus:
  | "open"
  | "degraded"
  | "paused"
  | "cohort-limited"
  | "unknown";
routeStatusSource:
  | "operator-notice"
  | "protocol-api"
  | "onchain-paused"
  | "market-implied"
  | "manual-reviewed";
```

Scoring behavior:

- `paused` -> `score = null` or capped to a very low incident score, with `resolutionState` extended to `unavailable`.
- `cohort-limited` -> visible but excluded from effective-exit/report-card liquidity uplift unless the UI can identify that cohort.
- `degraded` -> route cap and confidence downgrade.
- `unknown` on a stale review during an active depeg -> fail closed or require current review.

### 2. Add a peg/depeg contradiction gate

Use existing peg analytics as a sanity check, not as a primary score input:

- If active depeg exceeds a severe threshold, e.g. `>= 2500 bps`, and redemption score is high enough to imply par exit, require live redemption evidence from `routeStatus=open` or `live-direct`/API/on-chain proof.
- If no current proof exists, set `redemptionEligibleForLiquidity = false`, downgrade `modelConfidence = low`, or cap redemption backstop score for the duration of the active depeg.
- Require a cooldown after recovery, e.g. several successful peg observations or N hours/days below threshold, before restoring static documented-bound uplift.

This would catch USR without hard-coding USR: a stablecoin trading near `$0.16` for weeks is incompatible with a broadly available `82/100` par redemption rail.

### 3. Split "can eventually be redeemed" from "holder can exercise now"

The model already distinguishes `eventual-only` vs `immediate-bounded`, but it needs an exercisability dimension:

```ts
holderEligibility:
  | "any-holder"
  | "verified-customer"
  | "whitelisted-primary"
  | "pre-incident-holder"
  | "issuer-discretionary"
  | "unknown";
```

For USR, the currently relevant post-incident state is `pre-incident-holder`/`cohort-limited`, not `any-holder`. In normal conditions, Resolv terms imply at least `verified-customer`.

### 4. Tighten source precedence

Route review should prefer:

1. current incident/status notices
2. legal terms and app/API current state
3. protocol docs/litepaper route descriptions
4. reserve dashboards
5. generic website/product copy

For USR, product copy says instant redemption, but terms and postmortem materially constrain that claim. The config should not be able to stay `permissionless-onchain` + `atomic` when the reviewed legal terms say verified-customer and several-business-day processing.

### 5. Add incident-state inputs instead of per-asset overrides

Create a small typed registry or runtime feed for known route impairments:

```ts
RedemptionRouteIncident {
  stablecoinId: string;
  status: "paused" | "cohort-limited" | "degraded";
  startedAt: number;
  reviewedAt: string;
  sourceUrl: string;
  reason: string;
  expiresAt?: number;
}
```

This is still curated, but it is not a USR score override. It encodes live route availability and can be reused for any future stablecoin incident.

### 6. Add invariants and tests

Useful guardrails:

- A `stablecoin-redeem` route with `permissionless-onchain` + `atomic` must cite a contract/app flow proving any-holder redemption, not only a litepaper or terms page.
- Any `documented-bound` route with `reviewedAt` older than an active severe depeg start must be stale unless there is a current availability source.
- Report-card liquidity must not use redemption uplift when `peg.activeDepeg` exceeds the severe cap and redemption lacks live-open evidence.
- `issuer` or legal terms that require verified-customer status should not allow `permissionless-onchain`.

## Recommended implementation order

1. Add the peg contradiction gate for report-card liquidity and redemption effective-exit eligibility. This is the broadest safety net and can use data already loaded by report cards/depeg pipelines.
2. Add `routeStatus` / `holderEligibility` fields to redemption entries and configs.
3. Add a minimal incident registry or source layer for paused/cohort-limited routes.
4. Audit high-scoring `stablecoin-redeem` routes, especially docs-reviewed delta-neutral or issuer-mediated assets, for access/settlement mismatches.
5. Update methodology docs and changelog because this changes redemption backstop, effective exit, and report-card liquidity behavior.

## Expected result for USR under the proposed model

USR would remain visible as having a historically configured redemption route, but the current row would be marked `cohort-limited` or `paused/degraded`, with redemption uplift disabled while the active severe depeg persists and while current Resolv communications say most operations are paused. The detail card would show that the normal backstop is impaired instead of a standalone `82/100` green badge.
