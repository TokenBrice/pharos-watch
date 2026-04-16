# Redemption Backstop Comprehensive Remediation

**Goal:** Harden the redemption-backstop subsystem against silent scoring errors, correct confidence-level gaps, and extend coverage from 147 to 164 configured stablecoins by adding 17 new adapters with appropriate evidence.

**Architecture:** Three tracks executed in order:
1. Runtime correctness fixes (surface-invisible bugs, constants extraction, expanded edge-case tests).
2. Adapter-level confidence + doc corrections for existing configs.
3. Coverage expansion — 17 new config entries, each declaring explicit `capacityModel`, `costModel`, `docs`, `reviewedAt`, and `notes`.

**Scope decisions deliberately NOT taken** (documented here so future contributors understand what was considered and declined):
- `pht-pht` and `zeusd-zoth` are pure CDP vault systems with only debt-repayment routes; they do not expose a redemption rail for secondary holders, so adding a backstop config would overstate the exit path.
- `crvusd-curve`, `mim-abracadabra`, `susd-synthetix`, `usdb-blast`, `hollar-hydrated`, `hyusd-hylo`, `usdu-usdu-finance`, `uusd-youves`, `msusd-metronome`, `isc-international-stable-currency`, `frax-frax` (legacy, migrated to frxUSD), `pmusd-precious-metals`, `btcusd-btcfi`, `ggbr-goldfish-gold` — no primary-market redemption rail documented or opaque enough that modeling would overstate evidence quality.

**Tech Stack:** TypeScript, Vitest, Cloudflare D1/Workers. Changes are contained within `shared/lib/redemption-backstop-*`, `worker/src/lib/redemption-backstop-*`, `worker/src/api/redemption-backstops.ts`, `docs/redemption-backstops.md`, and tests under `__tests__/` directories next to each file.

---

## Success Criteria

- All existing tests pass after each task.
- `npm test` (vitest suite) passes globally at end.
- `npm run build` succeeds and `cd worker && npx tsc --noEmit` reports no errors.
- `npm run check:doc-counts` passes with updated coverage counts.
- Redemption backstop methodology version bumped with a single changelog entry summarizing all changes.
- No new orphaned imports or dead code.
- Every new config entry has `docs[]` with explicit URLs, `reviewedAt`, and `notes` — never placeholder prose.

---

## File Structure

**Modify:**
- `shared/lib/redemption-backstop-configs/collateral-redeem.ts` — add 2 new configs (dEURO, cjpy-yamato)
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` — add 4 new configs (wm-m0, ftusd-flying-tulip, usdz-anzen, usdsc-startale)
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts` — add 1 (silk-shade-protocol)
- `shared/lib/redemption-backstop-configs/queue-redeem.ts` — add 4 (usdat-saturn, usdnr-nerona, usdh-hermetica, buck-buck-assets)
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts` — add 6 (brla-brla-digital, ctusd-citrea, xo-exodus, usdk-kast, usdm-mega, usdkg-gold-dollar)
- `shared/lib/redemption-backstop-configs/shared.ts` — extract repeated patterns if needed
- `worker/src/lib/redemption-backstop-capacity.ts` — clamp `scoringCapacityUsd` when it exceeds `supplyUsd`
- `worker/src/lib/redemption-backstop-cost.ts` — extract fee-score breakpoints to named constants
- `worker/src/lib/redemption-backstop-live-metadata.ts` — replace hardcoded GHO exception with exported registry
- `shared/lib/redemption-backstop-version.ts` — bump to 3.98 with changelog entry
- `docs/redemption-backstops.md` — update coverage counts and add notes about new routes

**Create:**
- None. All work extends existing files.

**Test files to modify (add cases):**
- `worker/src/lib/__tests__/redemption-backstop-capacity.test.ts` — add over-supply capacity clamp test, negative-value behavior test
- `worker/src/lib/__tests__/redemption-backstop-cost.test.ts` — assert named constants
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts` — add test for live-metadata over-provisioned clamp
- `shared/lib/__tests__/redemption-backstops.test.ts` — add shape assertions for new configs
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts` — tighten consistency rules

---

## Part A — Runtime Correctness Fixes

### Task A1: Clamp `scoringCapacityUsd` to supply, surface note

**Files:**
- Modify: `worker/src/lib/redemption-backstop-capacity.ts:104-132`
- Test: `worker/src/lib/__tests__/redemption-backstop-capacity.test.ts`

**Context:** Today, when `immediateRedeemableUsd` exceeds `supplyUsd`, only the ratio is clamped to `[0, 1]` (line 111). The USD amount flows through unchanged to `scoringCapacityUsd`, so the `computeCapacityScore` still rewards the raw USD via the absolute-capacity breakpoints. An adapter emitting over-provisioned telemetry (bad data, or reserve bucket that mirrors several coins) would inflate the score silently.

- [ ] **Step 1: Write the failing test**

Edit `worker/src/lib/__tests__/redemption-backstop-capacity.test.ts`, append a new describe block before the last `});` of the file. The `ReserveSnapshotMetadataRecord` type requires `stablecoinId`, `fetchedAt`, `source`, `metadata`, `warningCount`, `warnings`, `sourceModel`, `evidenceClass`, and `syncStatus`. The `liquity-v1` adapter declares `redemptionTelemetry.capacity === "direct"` with `NOT_APPLICABLE_ONLY_FRESHNESS`, so the snapshot's `metadata.freshness.mode === "not-applicable"` satisfies the scoring-eligibility gate:

```typescript
import { resolveRedemptionCapacity } from "../redemption-backstop-capacity";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";

describe("resolveRedemptionCapacity — reserve-sync over-provisioned clamp", () => {
  const now = 1_780_000_000;
  const baseSnapshot = (metadata: Record<string, unknown>): ReserveSnapshotMetadataRecord => ({
    stablecoinId: "lusd-liquity",
    fetchedAt: now - 60,
    source: "liquity-v1",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    syncStatus: "ok",
    warningCount: 0,
    warnings: [],
    metadata,
  });

  it("clamps immediateCapacityUsd to supplyUsd and adds a note when nested capacityUsd exceeds supply", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 5_000_000 },
        }),
      },
    );
    expect(result.scoringCapacityUsd).toBe(supplyUsd);
    expect(result.scoringCapacityRatio).toBe(1);
    expect(result.immediateCapacityUsd).toBe(supplyUsd);
    expect(result.immediateCapacityRatio).toBe(1);
    expect(result.notes.some((n) => /exceeds current supply/i.test(n))).toBe(true);
  });

  it("clamps ratio-only over-provisioned live capacity to supply", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityRatioOfSupply: 1.5 },
        }),
      },
    );
    expect(result.scoringCapacityUsd).toBe(supplyUsd);
    expect(result.immediateCapacityUsd).toBe(supplyUsd);
    expect(result.immediateCapacityRatio).toBe(1);
    expect(result.notes.some((n) => /exceeds current supply/i.test(n))).toBe(true);
  });
});
```

Note: `describe`, `expect`, `it` are already imported at the top of this test file; no new import is needed for them.

- [ ] **Step 2: Run test to verify it fails**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-capacity.test.ts
```

Expected: FAIL — `scoringCapacityUsd` is `5_000_000`, not `1_000_000`.

- [ ] **Step 3: Implement the clamp**

Edit `worker/src/lib/redemption-backstop-capacity.ts`. Replace the block at roughly lines 100-132 (the `if (liveMetadata.canUseCapacity && ...)` branch) with:

```typescript
  if (
    liveMetadata.canUseCapacity
    && liveMetadata.capacityConfidence != null
    && (liveMetadata.immediateRedeemableUsd != null || (liveMetadata.immediateRedeemableRatio != null && supplyUsd != null))
  ) {
    const rawCapacityUsd =
      liveMetadata.immediateRedeemableUsd != null
        ? liveMetadata.immediateRedeemableUsd
        : (supplyUsd as number) * (liveMetadata.immediateRedeemableRatio as number);
    const hasPositiveSupply = supplyUsd != null && supplyUsd > 0;
    const capacityExceedsSupply = hasPositiveSupply && rawCapacityUsd > (supplyUsd as number);
    const immediateCapacityUsd = hasPositiveSupply
      ? Math.max(0, Math.min(supplyUsd as number, rawCapacityUsd))
      : Math.max(0, rawCapacityUsd);
    const derivedRatio =
      liveMetadata.immediateRedeemableRatio != null
        ? Math.max(0, Math.min(1, liveMetadata.immediateRedeemableRatio))
        : hasPositiveSupply
          ? Math.max(0, Math.min(1, immediateCapacityUsd / (supplyUsd as number)))
          : null;
    const clampNote = capacityExceedsSupply
      ? "Live reserve redemption capacity exceeds current supply; clamped to supply for scoring"
      : null;

    return {
      immediateCapacityUsd,
      immediateCapacityRatio: derivedRatio,
      scoringCapacityUsd: immediateCapacityUsd,
      scoringCapacityRatio: derivedRatio,
      provider: "reserve-sync-metadata",
      sourceMode: "dynamic",
      resolutionState: "resolved",
      capacityConfidence: liveMetadata.capacityConfidence,
      capacityBasis: resolveCapacityBasis(null, model, liveMetadata.capacityConfidence),
      capacitySemantics,
      ...(liveMetadata.routeStatus ? { routeStatus: liveMetadata.routeStatus } : {}),
      ...(liveMetadata.routeStatusSource ? { routeStatusSource: liveMetadata.routeStatusSource } : {}),
      ...(liveMetadata.routeStatusReason ? { routeStatusReason: liveMetadata.routeStatusReason } : {}),
      ...(liveMetadata.routeStatusReviewedAt ? { routeStatusReviewedAt: liveMetadata.routeStatusReviewedAt } : {}),
      notes: [
        ...liveMetadata.capacityNotes,
        ...(clampNote ? [clampNote] : []),
      ],
    };
  }
```

- [ ] **Step 4: Run test, expect PASS**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-capacity.test.ts
```

- [ ] **Step 5: Run the broader capacity/sources tests to check for regressions**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-capacity.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts
```

- [ ] **Step 6: Commit**

```
git add worker/src/lib/redemption-backstop-capacity.ts worker/src/lib/__tests__/redemption-backstop-capacity.test.ts
git commit -m "fix(redemption-backstop): clamp live capacity to supply and surface note"
```

---

### Task A2: Extract fee-score breakpoints to named constants

**Files:**
- Modify: `worker/src/lib/redemption-backstop-cost.ts:38-43`
- Test: `worker/src/lib/__tests__/redemption-backstop-cost.test.ts`

- [ ] **Step 1: Write the failing test asserting the exported constants**

Append to `worker/src/lib/__tests__/redemption-backstop-cost.test.ts`:

```typescript
import {
  REDEMPTION_FEE_SCORE_BREAKPOINTS,
  resolveBoundedFeeScore,
} from "../redemption-backstop-cost";

describe("REDEMPTION_FEE_SCORE_BREAKPOINTS", () => {
  it("drives resolveBoundedFeeScore consistently", () => {
    expect(resolveBoundedFeeScore(0)).toBe(100);
    for (const bp of REDEMPTION_FEE_SCORE_BREAKPOINTS) {
      expect(resolveBoundedFeeScore(bp.maxFeeBps)).toBe(bp.score);
    }
    expect(resolveBoundedFeeScore(REDEMPTION_FEE_SCORE_BREAKPOINTS[REDEMPTION_FEE_SCORE_BREAKPOINTS.length - 1].maxFeeBps + 1))
      .toBe(40);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-cost.test.ts
```

Expected: FAIL — import not defined.

- [ ] **Step 3: Implement constants + rewrite `resolveBoundedFeeScore`**

In `worker/src/lib/redemption-backstop-cost.ts` replace the function at lines 38-43:

```typescript
export const REDEMPTION_FEE_SCORE_BREAKPOINTS = [
  { maxFeeBps: 10, score: 100 },
  { maxFeeBps: 50, score: 80 },
  { maxFeeBps: 100, score: 60 },
] as const;

export const REDEMPTION_FEE_SCORE_HIGH_FEE_FALLBACK = 40;

export function resolveBoundedFeeScore(feeBps: number): number {
  for (const { maxFeeBps, score } of REDEMPTION_FEE_SCORE_BREAKPOINTS) {
    if (feeBps <= maxFeeBps) return score;
  }
  return REDEMPTION_FEE_SCORE_HIGH_FEE_FALLBACK;
}
```

- [ ] **Step 4: Run test, expect PASS**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-cost.test.ts
```

- [ ] **Step 5: Commit**

```
git add worker/src/lib/redemption-backstop-cost.ts worker/src/lib/__tests__/redemption-backstop-cost.test.ts
git commit -m "refactor(redemption-backstop): extract fee-score breakpoints to named constants"
```

---

### Task A3: Move GHO live-metadata warning exception to data-driven registry

**Files:**
- Modify: `worker/src/lib/redemption-backstop-live-metadata.ts:71-104`

**Context:** The current `CAPACITY_WARNING_EXCEPTIONS` object is an internal map keyed by stablecoin ID with stringly-typed warning codes as values. Future exceptions (e.g., for a similar reserve-completeness warning on another PSM-style coin) require editing this code file. Extract it into an exported const and keep the behavior identical.

- [ ] **Step 1: Determine whether the test file already exists**

Run:
```
ls worker/src/lib/__tests__/redemption-backstop-live-metadata.test.ts 2>&1
```

If the file exists, append the new describe block below to it and skip the top-level `import` additions (they are already there). If it does not exist, create the file with the full imports + describe block below.

- [ ] **Step 2: Add the failing test**

File content for a new file (or append the describe block to the existing file):

```typescript
import { describe, expect, it } from "vitest";
import { REDEMPTION_CAPACITY_WARNING_EXCEPTIONS } from "../redemption-backstop-live-metadata";

describe("REDEMPTION_CAPACITY_WARNING_EXCEPTIONS", () => {
  it("declares the gho-aave aggregated-residual-issuance exception", () => {
    const ghoExceptions = REDEMPTION_CAPACITY_WARNING_EXCEPTIONS["gho-aave"];
    expect(ghoExceptions).toBeDefined();
    expect(ghoExceptions?.["aggregated-residual-issuance"]).toMatch(/GSM backing/);
  });
});
```

- [ ] **Step 3: Run test, expect FAIL**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-live-metadata.test.ts
```

- [ ] **Step 4: Verify no external consumers of the old name**

```
grep -rn 'CAPACITY_WARNING_EXCEPTIONS' worker/ shared/ src/ scripts/
```

The only references should be within `worker/src/lib/redemption-backstop-live-metadata.ts` (the declaration line plus 2 internal call sites). If you see references in any other file, stop and investigate — external consumers must be updated in the same edit.

- [ ] **Step 5: Export the registry, keep runtime behavior unchanged**

In `worker/src/lib/redemption-backstop-live-metadata.ts`, change:

```typescript
const CAPACITY_WARNING_EXCEPTIONS: Partial<Record<string, Partial<Record<string, string>>>> = {
```

to:

```typescript
export const REDEMPTION_CAPACITY_WARNING_EXCEPTIONS: Readonly<Partial<Record<string, Partial<Record<string, string>>>>> = {
```

And rename the 2 internal usage sites from `CAPACITY_WARNING_EXCEPTIONS` to `REDEMPTION_CAPACITY_WARNING_EXCEPTIONS`. `replace_all: true` is safe because Step 4 confirmed no external references exist.

- [ ] **Step 6: Run full live-metadata + sources test battery**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-live-metadata.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts
```

- [ ] **Step 7: Commit**

```
git add worker/src/lib/redemption-backstop-live-metadata.ts worker/src/lib/__tests__/redemption-backstop-live-metadata.test.ts
git commit -m "refactor(redemption-backstop): export capacity warning exception registry"
```

---

### Task A4: Deduplicate notes in `buildRedemptionBackstopEntry`

**Files:**
- Modify: `worker/src/lib/redemption-backstop-sources.ts:179-184`
- Test: `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`

**Context:** Notes are concatenated from config + capacity + static fields + routeStatusReason. With the A1 clamp note and future additions, duplicate entries can appear when a config note overlaps a runtime note. Deduplicate while preserving order.

- [ ] **Step 1: Add the failing test**

Append to `worker/src/lib/__tests__/redemption-backstop-sources.test.ts` inside the existing main describe block. Use `"usdt-tether"` as a stable real-registry ID that is guaranteed present but not affected by reserve-sync-metadata (its `capacityModel` is `supply-full` in the real registry — but the test overrides the config inline with `supply-ratio`, which bypasses the reserve-sync branch, so no D1 call is made). Passing `reserveSnapshotMetadata: null` additionally ensures the D1 lookup is skipped:

```typescript
it("deduplicates notes when config + runtime emit the same string", async () => {
  const db = {} as D1Database;
  const entry = await buildRedemptionBackstopEntry(
    db,
    "usdt-tether",
    {
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      capacityModel: { kind: "supply-ratio", ratio: 0.33 },
      costModel: { kind: "fee-bps", feeBps: 0 },
      notes: ["Shared note", "Shared note", "Distinct note"],
    },
    1_000_000,
    50,
    1_780_000_000,
    { reserveSnapshotMetadata: null },
  );
  expect(entry.notes.filter((n) => n === "Shared note").length).toBe(1);
  expect(entry.notes.filter((n) => n === "Distinct note").length).toBe(1);
});
```

The `supply-ratio` capacity model avoids the reserve-sync branch entirely; combined with the explicit `reserveSnapshotMetadata: null`, no D1 lookup happens against the `{}` db stub. Ensure `buildRedemptionBackstopEntry` is imported at the top of the test file; add the import if missing.

- [ ] **Step 2: Run, expect FAIL**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-sources.test.ts
```

- [ ] **Step 3: Implement the dedup**

In `worker/src/lib/redemption-backstop-sources.ts`, change the notes assembly (around lines 179-184) from:

```typescript
  const notes = [
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...(routeStatusReason ? [routeStatusReason] : []),
  ];
```

to:

```typescript
  const notes = dedupNotes([
    ...(config.notes ?? []),
    ...capacity.notes,
    ...staticFields.notes,
    ...(routeStatusReason ? [routeStatusReason] : []),
  ]);
```

And add a small helper at the bottom of the file (before the final `export`):

```typescript
function dedupNotes(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    if (seen.has(note)) continue;
    seen.add(note);
    out.push(note);
  }
  return out;
}
```

- [ ] **Step 4: Run, expect PASS**

```
npm test -- worker/src/lib/__tests__/redemption-backstop-sources.test.ts
```

- [ ] **Step 5: Commit**

```
git add worker/src/lib/redemption-backstop-sources.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts
git commit -m "fix(redemption-backstop): dedupe notes when config overlaps runtime"
```

---

### Task A5 (removed — redundant with existing test)

The existing test at `shared/lib/__tests__/redemption-backstop-consistency.test.ts:278-298` ("reserve-sync routes point only at adapters with redeemable-capacity telemetry and reviewed docs") already enforces this exact invariant. No new test is added here.

---

## Part B — Adapter Confidence + Docs Corrections

### Task B1: Add explicit fallback note to configs that rely on telemetry without a fallback ratio

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts` (usdf-falcon — `fallbackRatio` is absent)
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` (frxusd-frax — `fallbackRatio` absent)

**Context:** Today, when live reserve telemetry is absent or stale and no `fallbackRatio` is set, the route falls through to a `missing-capacity` state. This is intentional fail-closed behavior, but the `notes` field should explicitly declare that the route intentionally becomes unrated under those conditions.

- [ ] **Step 1: Add notes to usdf-falcon**

In `shared/lib/redemption-backstop-configs/queue-redeem.ts`, within the `"usdf-falcon"` entry, extend the `notes` array:

```typescript
  "usdf-falcon": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Falcon docs state users bear gas and execution costs while Falcon does not charge a separate protocol-specific redemption fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [ /* unchanged */ ],
    notes: [
      "Fresh live reserve metadata scores against Falcon's current stablecoin reserve bucket; redeemed assets are still credited only after the documented 7-day cooldown",
      "If the Falcon transparency API snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
    ],
  },
```

- [ ] **Step 2: Add notes to frxusd-frax**

In `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`, within the `"frxusd-frax"` entry, extend `notes`:

```typescript
    notes: [
      "Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail",
      "If the Frax balance-sheet snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
    ],
```

- [ ] **Step 3: Run consistency + shape tests**

```
npm test -- shared/lib/__tests__/redemption-backstops.test.ts shared/lib/__tests__/redemption-backstop-consistency.test.ts
```

- [ ] **Step 4: Commit**

```
git add shared/lib/redemption-backstop-configs/queue-redeem.ts shared/lib/redemption-backstop-configs/stablecoin-redeem.ts
git commit -m "docs(redemption-backstop): document fail-closed fallback semantics for falcon and frxusd"
```

---

## Part C — Coverage Expansion (16 new configs)

For each task below, after adding the config:
1. Add entry to the appropriate route-family file.
2. Add a reviewed-docs reference using `sourceRef`.
3. Set `reviewedAt` to `"2026-04-16"`.
4. Run the full consistency + shape tests.
5. Commit.

### Task C1: Add dEURO (deuro-deuro) — collateral-redeem

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/collateral-redeem.ts`

**Reasoning:** dEURO is a Frankencoin architecture fork. It uses a position-based, oracle-free CDP where users burn dEURO to redeem collateral from positions below their redemption threshold. Modeled analogously to `zchf-frankencoin` minus the VCHF bridge (no external stablecoin target). Without a direct primary-market stable rail, capacity stays at `supply-full` eventual.

- [ ] **Step 1: Add the config**

In `shared/lib/redemption-backstop-configs/collateral-redeem.ts` in the map (after the "usdp-parallel" entry), add:

```typescript
  "deuro-deuro": {
    ...collateralRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "dEURO allows burning tokens against collateralized positions below the position's redemption threshold; public docs reviewed describe a governance-managed fee schedule without a single fixed bps number",
    ),
    docs: [
      sourceRef("dEURO documentation", "https://docs.deuro.com/", ["route", "capacity"]),
      sourceRef("dEURO app", "https://app.deuro.com/", ["route"]),
    ],
    notes: [
      "Frankencoin-fork CDP: dEURO is minted against position-specific collateral and burned at par against positions below their redemption threshold, without an external stablecoin target rail",
    ],
  },
```

- [ ] **Step 2: Run consistency tests**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
```

- [ ] **Step 3: Commit**

```
git add shared/lib/redemption-backstop-configs/collateral-redeem.ts
git commit -m "feat(redemption-backstop): add dEURO collateral-redeem config"
```

---

### Task C2: Add cjpy-yamato — collateral-redeem

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/collateral-redeem.ts`

**Reasoning:** Yamato publishes a hard floor redemption of 1 CJPY against 1 JPY worth of ETH from the riskiest pledge on-chain. This is a Liquity-style redemption mechanism.

- [ ] **Step 1: Add the config**

```typescript
  "cjpy-yamato": {
    ...collateralRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    outputAssetType: "bluechip-collateral",
    costModel: documentedVariableFee(
      "Yamato docs describe on-chain CJPY-for-ETH redemption against the riskiest pledge; fee structure is set by protocol mechanics rather than a single fixed bps number",
    ),
    docs: [
      sourceRef("Yamato Protocol", "https://yamato.jp/", ["route"]),
      sourceRef("Yamato docs", "https://yamato-protocol.gitbook.io/docs/", ["route", "capacity", "fees"]),
    ],
    notes: [
      "On-chain redemption redeems 1 CJPY for 1 JPY worth of ETH from the riskiest pledge, providing a permissionless hard floor",
    ],
  },
```

- [ ] **Step 2: Run tests**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
```

- [ ] **Step 3: Commit**

```
git add shared/lib/redemption-backstop-configs/collateral-redeem.ts
git commit -m "feat(redemption-backstop): add CJPY Yamato collateral-redeem config"
```

---

### Task C3: Add wm-m0 — stablecoin-redeem (permissionless M0 wrapper)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

**Reasoning:** wM is a permissionless 1:1 ERC-20 wrapper. Anyone can call `unwrap()` to redeem wM back to M without fees. Model as stablecoin-redeem with permissionless-onchain access.

- [ ] **Step 1: Add the config**

In `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`, append to the map:

```typescript
  "wm-m0": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    totalScoreCap: 70,
    costModel: fixedFee(0, "wM docs describe wrap and unwrap as fee-free permissionless calls against the underlying M token"),
    docs: [
      sourceRef("M0 wM token", "https://www.m0.org/faq", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Permissionless ERC-20 wrapper: wrap() deposits M and mints wM; unwrap() redeems 1:1 back to M with no fee or queue",
      "Config-level cap reflects that the wM->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail (institution-only M0 mint/burn) still gates actual par exit",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/stablecoin-redeem.ts
git commit -m "feat(redemption-backstop): add wM M0 stablecoin-redeem config"
```

---

### Task C4: Add ftusd-flying-tulip — stablecoin-redeem

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

**Reasoning:** Flying Tulip's MintAndRedeem contract supports 1:1 mint and redemption against USDC or USDT on-chain. Delta-neutral reserve strategy — use a conservative supply-ratio bound rather than full supply.

- [ ] **Step 1: Add the config**

```typescript
  "ftusd-flying-tulip": {
    ...stablecoinRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Flying Tulip's MintAndRedeem contract supports permissionless 1:1 mint and redemption against USDC or USDT; public docs reviewed do not publish a fixed redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Flying Tulip documentation", "https://docs.flyingtulip.com/", ["route", "capacity"]),
    ],
    notes: [
      "ftUSD uses delta-neutral stablecoin lending + short perpetual hedging",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol on-hand stable buffers rather than a published instant-liquidity floor for this specific protocol",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/stablecoin-redeem.ts
git commit -m "feat(redemption-backstop): add ftUSD Flying Tulip stablecoin-redeem config"
```

---

### Task C5: Add usdz-anzen — stablecoin-redeem (whitelisted QMM)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdz-anzen": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Qualified Market Makers mint and redeem 1:1 USDz/USDC against SPCT collateral; public docs reviewed do not publish a fixed retail redemption fee",
    ),
    docs: [
      sourceRef("Anzen Finance", "https://www.anzen.finance/", ["route"]),
      sourceRef("Anzen documentation", "https://docs.anzen.finance/", ["route", "capacity"]),
    ],
    notes: [
      "Primary mint and redeem rail is reserved for whitelisted Qualified Market Makers; retail holders exit via DEX liquidity while arbitrage by QMMs maintains the peg against SPCT collateral",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/stablecoin-redeem.ts
git commit -m "feat(redemption-backstop): add USDz Anzen stablecoin-redeem config"
```

---

### Task C6: Add usdsc-startale — stablecoin-redeem (M0 wrapper permissionless)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdsc-startale": {
    ...stablecoinRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    totalScoreCap: 70,
    costModel: fixedFee(0, "Startale docs describe USDSC as a fee-free 1:1 wrapper around M0's M token on Soneium"),
    docs: [
      sourceRef("Startale USDSC", "https://startale.com/usdsc", ["route", "capacity", "fees"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "1:1 wrapper around M: mint by wrapping, redeem by unwrapping; underlying M is backed by T-bill collateral attested by M0 Validators",
      "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/stablecoin-redeem.ts
git commit -m "feat(redemption-backstop): add USDSC Startale stablecoin-redeem config"
```

---

### Task C7: Add silk-shade-protocol — basket-redeem

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/psm-and-basket.ts`

- [ ] **Step 1: Add the config**

```typescript
  "silk-shade-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Shade Protocol documents Silk redemption pools plus ShadeDAO bond-assisted arbitrage; public docs reviewed do not publish a single fixed bps redemption fee",
    ),
    docs: [
      sourceRef("Shade Protocol Silk docs", "https://docs.shadeprotocol.io/silk", ["route", "capacity"]),
    ],
    notes: [
      "Silk tracks a basket of GDP-weighted currencies; redemption pools combined with ShadeLend overcollateralization provide a reviewed basket-exit rail rather than a single-stable PSM",
      "Output asset type is mixed-collateral because the redeemed basket is not guaranteed to be all-stablecoin; it can include native Shade collateral assets",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/psm-and-basket.ts
git commit -m "feat(redemption-backstop): add Silk Shade Protocol basket-redeem config"
```

---

### Task C8: Add usdat-saturn — queue-redeem (whitelisted)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdat-saturn": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Saturn documents KYC-gated 1:1 USDC mint and redeem through the M0 Swap Facility (Uniswap V3 1bps tier); public docs reviewed do not publish a separate USDAT protocol redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Saturn USDAT", "https://saturn.money/usdat", ["route", "capacity"]),
      sourceRef("Saturn documentation", "https://docs.saturn.money/", ["route", "access"]),
    ],
    notes: [
      "USDAT is a permissioned M0 wrapper: mint/redeem requires KYC onboarding and is geofenced away from US, EEA, and OFAC jurisdictions; routes through the Uniswap V3 1bps tier against USDC",
      "The 50% ratio is a reviewed heuristic placeholder for M0 Swap Facility liquidity pending a published quantitative buffer bound",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/queue-redeem.ts
git commit -m "feat(redemption-backstop): add USDAT Saturn queue-redeem config"
```

---

### Task C9: Add usdnr-nerona — queue-redeem (whitelisted)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdnr-nerona": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Nerona documents permissioned 1:1 USDnr mint and redeem against underlying M; public docs reviewed do not publish a separate numeric redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Nerona documentation", "https://docs.nerona.finance/", ["route", "capacity", "access"]),
    ],
    notes: [
      "Permissioned M0 wrapper: KYC-gated to Nerona's private wealth platform clients; T-bill yield accrues to M0/Nerona rather than USDnr holders",
      "The 50% ratio is a reviewed heuristic placeholder pending a published primary-market liquidity bound for Nerona's M wrapper",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/queue-redeem.ts
git commit -m "feat(redemption-backstop): add USDnr Nerona queue-redeem config"
```

---

### Task C10: Add buck-buck-assets — queue-redeem (whitelisted LiquidityWindow)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "buck-buck-assets": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Buck Assets documents 1:1 USDC mint and redemption via the LiquidityWindow smart contract for AML-verified participants; public docs reviewed do not publish a fixed redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Buck Assets", "https://buck.assets/", ["route", "capacity"]),
      sourceRef("Buck Assets documentation", "https://docs.buck.assets/", ["route", "access"]),
    ],
    notes: [
      "LiquidityWindow contract gates primary mint/redeem to AML-verified primary-market participants; monthly yield is distributed as additional BUCK tokens via rebase",
      "The 10% ratio is a reviewed heuristic placeholder pending a published LiquidityWindow buffer figure",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/queue-redeem.ts
git commit -m "feat(redemption-backstop): add BUCK Buck Assets queue-redeem config"
```

---

### Task C11: Add usdh-hermetica — queue-redeem (whitelisted delta-neutral BTC)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdh-hermetica": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "Hermetica documents KYC-gated USDH mint and redemption against a delta-neutral BTC position; public docs reviewed do not publish a fixed redemption fee",
    ),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("Hermetica", "https://hermetica.fi/", ["route"]),
      sourceRef("Hermetica documentation", "https://docs.hermetica.fi/", ["route", "capacity", "access"]),
    ],
    notes: [
      "Delta-neutral BTC strategy (spot long + short perpetual) on Stacks; KYC-gated mint/redeem via the Hermetica app",
      "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol cash buffers rather than a published Hermetica-specific figure",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/queue-redeem.ts
git commit -m "feat(redemption-backstop): add USDH Hermetica queue-redeem config"
```

---

### Task C12: Add brla-brla-digital — offchain-issuer (fiat BRL)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "brla-brla-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "Avenia (formerly BRLA Digital) documents 1:1 BRLA mint and redemption against BRL after KYC; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    docs: [
      sourceRef("BRLA Digital", "https://brla.digital/", ["route", "capacity"]),
      sourceRef("Avenia documentation", "https://docs.avenia.io/", ["route", "access"]),
    ],
    notes: ["Native multichain fiat-backed BRL stablecoin; KYC-gated primary mint and redeem rail via Avenia"],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add BRLA BRLA Digital offchain-issuer config"
```

---

### Task C13: Add ctusd-citrea — offchain-issuer (MoonPay/M0)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "ctusd-citrea": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "Citrea documents 1:1 fiat mint and redemption via MoonPay using M0 Protocol infrastructure; MoonPay fiat-ramp fees apply while public docs reviewed do not publish a separate Citrea protocol redemption fee",
    ),
    docs: [
      sourceRef("Citrea", "https://citrea.xyz/", ["route", "capacity"]),
      sourceRef("Citrea documentation", "https://docs.citrea.xyz/", ["route"]),
    ],
    notes: [
      "Fiat-backed via MoonPay; reserves cryptographically attested on-chain by M0 Validators before minting",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add ctUSD Citrea offchain-issuer config"
```

---

### Task C14: Add xo-exodus — offchain-issuer (MoonPay/M0 on Solana)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "xo-exodus": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "Exodus XO documents 1:1 fiat mint and redemption via MoonPay using M0 Protocol infrastructure; MoonPay fiat-ramp fees apply while public docs reviewed do not publish a separate XO protocol redemption fee",
    ),
    docs: [
      sourceRef("Exodus Pay", "https://www.exodus.com/exodus-pay", ["route", "capacity"]),
      sourceRef("MoonPay", "https://www.moonpay.com/", ["route"]),
    ],
    notes: [
      "Solana SPL Token-2022 mint with pausable, permanent-delegate, and transfer-hook authorities held by MoonPay",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add XO Exodus offchain-issuer config"
```

---

### Task C15: Add usdk-kast — offchain-issuer (M0 Solana wrapper with fiat ramp)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdk-kast": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "KAST documents 1:1 mint by wrapping M (M0), and redemption by unwrapping; the fiat on/off-ramp is mediated by licensed partners (Tazapay, BitGo, Fireblocks) whose fees apply separately",
    ),
    docs: [
      sourceRef("KAST documentation", "https://docs.kast.finance/", ["route", "capacity"]),
      sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
    ],
    notes: [
      "Solana SPL Token-2022 wrapper around M (M0); mint/redeem gated by KAST app and licensed payment partners",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add USDK KAST offchain-issuer config"
```

---

### Task C16: Add usdm-mega — offchain-issuer (Ethena USDtb rails)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdm-mega": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    costModel: documentedVariableFee(
      "USDM is issued on Ethena's USDtb rails; primary redemption follows USDtb's documented issuer rail and is KYC-gated; public USDM-specific redemption fees are not published",
    ),
    docs: [
      sourceRef("MegaETH", "https://www.megaeth.com/", ["route"]),
      sourceRef("Ethena USDtb", "https://ethena.fi/usdtb", ["route", "capacity"]),
    ],
    notes: [
      "USDM reuses Ethena's USDtb issuer redemption rail; reserve yield funds MegaETH sequencer costs",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add USDM Mega offchain-issuer config"
```

---

### Task C17: Add usdkg-gold-dollar — offchain-issuer (Kyrgyz Republic multi-redemption)

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`

- [ ] **Step 1: Add the config**

```typescript
  "usdkg-gold-dollar": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    settlementModel: "days",
    costModel: documentedVariableFee(
      "Gold Dollar documents 1:1 USDKG mint and redemption against USD, KGS, physical gold, or approved cryptocurrencies after KYC/AML; public docs reviewed do not publish a fixed numeric redemption fee",
    ),
    docs: [
      sourceRef("Gold Dollar USDKG", "https://usdkg.com/", ["route", "capacity"]),
    ],
    notes: [
      "Licensed under Kyrgyz Republic Law on Virtual Assets (2022) / Cabinet Resolution No. 514; mutliple redemption outputs supported (USD, KGS, physical gold, or approved crypto)",
    ],
  },
```

- [ ] **Step 2-3: Test + commit**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
git add shared/lib/redemption-backstop-configs/offchain-issuer.ts
git commit -m "feat(redemption-backstop): add USDKG Gold Dollar offchain-issuer config"
```

---

## Part D — Existing Config Upgrades

### Task D1: Add docs + reviewedAt + basis to lower-confidence existing configs

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` (dusd-dtrinity, yousd-yield-optimizer)
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts` (uty-xsy)

**Context:** These configs rely on supply-ratio heuristics without explicit `confidence: "documented-bound"` or `reviewedAt`. They should either cite evidence for the ratio (making them documented-bound) or remain heuristic explicitly — no silent in-between.

- [ ] **Step 1: Update dusd-dtrinity with explicit heuristic tag**

In `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`, change:

```typescript
  "dusd-dtrinity": {
    ...stablecoinRedeemBase,
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.4 },
    costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
  },
```

to:

```typescript
  "dusd-dtrinity": {
    ...stablecoinRedeemBase,
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    capacityModel: { kind: "supply-ratio", ratio: 0.4, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
    reviewedAt: "2026-04-16",
    docs: [
      sourceRef("dTrinity documentation", "https://docs.dtrinity.org/", ["route", "capacity", "fees"]),
    ],
    notes: [
      "The 40% ratio is a reviewed heuristic reflecting tracked stable-bucket share rather than a published instant-liquidity floor",
    ],
  },
```

- [ ] **Step 2: Update yousd-yield-optimizer similarly**

```typescript
  "yousd-yield-optimizer": {
    ...stablecoinRedeemBase,
    settlementModel: "immediate",
    executionModel: "rules-based-nav",
    capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(
      "ERC-4626 vault; instant redemptions up to liquidity buffer, larger withdrawals up to 24h as cross-chain positions unwind",
    ),
    reviewedAt: "2026-04-16",
    notes: [
      "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
    ],
  },
```

- [ ] **Step 3: Update uty-xsy similarly**

In `shared/lib/redemption-backstop-configs/queue-redeem.ts`:

```typescript
  "uty-xsy": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3, confidence: "heuristic", basis: "strategy-buffer" },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
    reviewedAt: REVIEWED_QUEUE_REDEMPTION_AT,
    docs: [ /* unchanged */ ],
    notes: [
      "XSY documents a 7-day unbonding redemption path for UTY back into USDC; current model scores the reviewed queued exit rather than a separately measured live liquid buffer",
      "The 30% ratio is a reviewed heuristic reflecting delta-neutral AVAX hedge composition rather than a published instant-liquidity floor",
    ],
  },
```

- [ ] **Step 4: Run consistency tests**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
```

- [ ] **Step 5: Commit**

```
git add shared/lib/redemption-backstop-configs/stablecoin-redeem.ts shared/lib/redemption-backstop-configs/queue-redeem.ts
git commit -m "fix(redemption-backstop): tag heuristic supply-ratios explicitly and add reviewed docs"
```

---

## Part E — Methodology Version, Docs, Final Checks

### Task E1: Bump methodology version with changelog entry

**Files:**
- Modify: `shared/lib/redemption-backstop-version.ts`

- [ ] **Step 1: Add new changelog entry at the top of the changelog array**

In `shared/lib/redemption-backstop-version.ts`, bump `currentVersion` to `"3.98"` and prepend this changelog entry:

```typescript
    {
      version: "3.98",
      title: "Capacity-over-supply clamp, coverage expansion, and runtime hardening",
      date: "2026-04-16",
      effectiveAt: 1776297600,
      summary:
        "Live reserve capacity is now clamped to current supply for scoring, 17 new stablecoins join modeled redemption coverage, and several lower-confidence supply-ratio routes are explicitly tagged as heuristic rather than silently relying on uncited ratios.",
      impact: [
        "Live redemption capacity greater than current supply is now clamped to supply for scoring and surfaces an explicit note; previously only the ratio was clamped while the raw USD amount flowed through unchanged",
        "17 new stablecoins added to redemption coverage: dEURO, CJPY, wM, ftUSD, USDz, USDSC, Silk, USDAT, USDnr, BUCK, USDH, BRLA, ctUSD, XO, USDK, USDM, and USDKG, spanning collateral-redeem, stablecoin-redeem, basket-redeem, queue-redeem, and offchain-issuer families",
        "Lower-confidence supply-ratio routes (dusd-dtrinity, yousd-yield-optimizer, uty-xsy) now carry explicit `confidence: heuristic` plus reviewed docs rather than silently defaulting to heuristic with no evidence trail",
        "Fee-score breakpoints extracted to named constants, GHO capacity warning exception registry exported for reuse, and route notes deduplicated end-to-end",
      ],
      commits: [],
      reconstructed: false,
    },
```

- [ ] **Step 2: Run version-related tests**

```
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts
```

- [ ] **Step 3: Commit**

```
git add shared/lib/redemption-backstop-version.ts
git commit -m "chore(redemption-backstop): bump methodology version to 3.98"
```

---

### Task E2: Update coverage counts in docs/redemption-backstops.md

**Files:**
- Modify: `docs/redemption-backstops.md:9, 13, 23-24`

- [ ] **Step 1: Update methodology version**

In `docs/redemption-backstops.md`, replace "Current methodology version: `v3.97`" with `v3.98`. Replace the "Latest `v3.97` update: ..." sentence in the paragraph below with a one-sentence summary of the v3.98 changes consistent with the changelog entry:

```markdown
Latest `v3.98` update: live reserve capacity is now clamped to current supply for scoring, 17 new stablecoins join modeled redemption coverage (spanning collateral-redeem, stablecoin-redeem, basket-redeem, queue-redeem, and offchain-issuer families), and several lower-confidence supply-ratio routes are explicitly tagged as heuristic with reviewed docs.
```

- [ ] **Step 2: Update coverage counts**

Replace:

```markdown
- **Configured coins:** 147
- **Route families:** 81 `offchain-issuer`, 21 `stablecoin-redeem`, 19 `collateral-redeem`, 15 `queue-redeem`, 8 `psm-swap`, 3 `basket-redeem`
```

with (additions from Part C: +6 offchain-issuer, +4 stablecoin-redeem, +2 collateral-redeem, +4 queue-redeem, +1 basket-redeem = +17 total; 147 + 17 = 164):

```markdown
- **Configured coins:** 164
- **Route families:** 87 `offchain-issuer`, 25 `stablecoin-redeem`, 21 `collateral-redeem`, 19 `queue-redeem`, 8 `psm-swap`, 4 `basket-redeem`
```

After the task completes, run `node scripts/check-redemption-backstops.ts` (or the doc-count check) to verify the final tallies. If the tallies differ, update the doc numbers to match the actual registry, not the plan's projection.

- [ ] **Step 3: Run doc sync check**

```
npm run check:doc-counts
```

Expected: PASS. If it reports a mismatch, update the doc numbers to match the actual counts.

- [ ] **Step 4: Commit**

```
git add docs/redemption-backstops.md
git commit -m "docs(redemption-backstop): update coverage counts and methodology version"
```

---

### Task E3: Full test suite + type check + doc check

- [ ] **Step 1: Run the whole vitest suite**

```
npm test
```

Expected: all tests green. Any failure indicates an integration-level regression introduced during Parts A–D.

- [ ] **Step 2: Worker type check**

```
cd worker && npx tsc --noEmit
cd ..
```

Expected: no errors.

- [ ] **Step 3: Lint**

```
npm run lint
```

Expected: no errors. Fix any import or unused-variable nits introduced during the changes.

- [ ] **Step 4: Build**

```
npm run build
```

Expected: success.

- [ ] **Step 5: Doc-count check**

```
npm run check:doc-counts
```

- [ ] **Step 6: Pre-push merge gate**

```
npm run test:merge-gate
```

Expected: PASS.

- [ ] **Step 7: If any step fails, STOP and investigate the root cause.** Do not skip hooks or force-push.

- [ ] **Step 8: Commit any final adjustments as `chore: final cleanup`.**

---

## Self-Review

Completed inline before executing.

- Spec coverage: every audit finding maps to a task (A1–A5 cover runtime bugs; B1 covers adapter notes; C1–C19 cover coverage; D1 covers upgrades; E1–E3 cover docs/version/verification).
- Placeholder scan: none remain; all code blocks are literal. `/* unchanged */` markers are acceptable as they refer to existing in-file content.
- Type consistency: all `sourceRef` / `documentedVariableFee` / `fixedFee` / `documentedBoundSupplyFull` signatures match the definitions in `shared/lib/redemption-backstop-configs/shared.ts`.
- Ambiguity check: where a task requires manual adjustment (e.g., the doc-count at E2), explicit fallback instructions are included.
