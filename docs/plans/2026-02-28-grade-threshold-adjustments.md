# Grade Threshold Adjustments: Blacklist & Decentralization Scoring

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Soften two structurally harsh scoring dimensions so the grade distribution better reflects real-world trust — blacklist capability scored as 100/66/33 instead of 100/50/0, and a new `regulated-entity` governance tier (score 40) that programmatically distinguishes regulated issuers from unknown single entities.

**Architecture:** Two isolated changes inside `src/lib/report-cards.ts` plus a type addition. The `regulated-entity` tier is auto-derived from existing metadata fields (`jurisdiction.regulator`, `jurisdiction.license`, `proofOfReserves.type`) via a new `inferGovernanceQuality` path — no manual tagging needed. The manual `governanceQuality` override on `StablecoinMeta` remains as an escape hatch.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add `regulated-entity` to `GovernanceQuality` type

**Files:**
- Modify: `src/lib/types.ts:95`

**Step 1: Update the type union**

Change:
```typescript
export type GovernanceQuality = "dao-governance" | "multisig" | "single-entity" | "wrapper";
```
To:
```typescript
export type GovernanceQuality = "dao-governance" | "multisig" | "regulated-entity" | "single-entity" | "wrapper";
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Errors in `report-cards.ts` about missing `regulated-entity` keys in Record types — that's expected, we fix them in Task 2.

**Step 3: Commit**

```
feat(types): add regulated-entity to GovernanceQuality union
```

---

### Task 2: Wire `regulated-entity` into scoring tables and inference

**Files:**
- Modify: `src/lib/report-cards.ts` (lines 398-502)

**Step 1: Update blacklist scoring (line 403)**

Change:
```typescript
const blacklistScore = canBeBlacklisted === true ? 0 : canBeBlacklisted === "possible" ? 50 : 100;
```
To:
```typescript
const blacklistScore = canBeBlacklisted === true ? 33 : canBeBlacklisted === "possible" ? 66 : 100;
```

**Step 2: Add `regulated-entity` to governance scoring table (line 435-439)**

Change:
```typescript
export const GOVERNANCE_QUALITY_SCORE: Record<GovernanceQuality, number> = {
  "dao-governance": 85,
  "multisig": 55,
  "single-entity": 20,
  "wrapper": 10,
};
```
To:
```typescript
export const GOVERNANCE_QUALITY_SCORE: Record<GovernanceQuality, number> = {
  "dao-governance": 85,
  "multisig": 55,
  "regulated-entity": 40,
  "single-entity": 20,
  "wrapper": 10,
};
```

**Step 3: Add `regulated-entity` to governance label table (line 442-447)**

Change:
```typescript
const GOVERNANCE_QUALITY_LABEL: Record<GovernanceQuality, string> = {
  "dao-governance": "DAO governance",
  "multisig": "Multisig governance",
  "single-entity": "Single-entity governance",
  "wrapper": "Wrapper (inherits upstream)",
};
```
To:
```typescript
const GOVERNANCE_QUALITY_LABEL: Record<GovernanceQuality, string> = {
  "dao-governance": "DAO governance",
  "multisig": "Multisig governance",
  "regulated-entity": "Regulated entity",
  "single-entity": "Single-entity governance",
  "wrapper": "Wrapper (inherits upstream)",
};
```

**Step 4: Update `inferGovernanceQuality` to detect regulated entities (line 449-455)**

The current function only looks at `GovernanceType`. We need to also accept the `StablecoinMeta` to check jurisdiction/PoR fields. But since `resolveGovernanceQuality` (line 457-462) already receives `meta` and calls `inferGovernanceQuality` as fallback, the cleanest approach is to add the regulated-entity logic inside `resolveGovernanceQuality`.

Change `resolveGovernanceQuality`:
```typescript
export function resolveGovernanceQuality(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): GovernanceQuality {
  return meta?.governanceQuality ?? inferGovernanceQuality(governance);
}
```
To:
```typescript
export function resolveGovernanceQuality(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): GovernanceQuality {
  if (meta?.governanceQuality) return meta.governanceQuality;
  const base = inferGovernanceQuality(governance);
  // Auto-promote single-entity → regulated-entity when metadata confirms regulation
  if (base === "single-entity" && meta) {
    const j = meta.jurisdiction;
    const p = meta.proofOfReserves;
    if (j?.regulator && j?.license && p?.type === "independent-audit") {
      return "regulated-entity";
    }
  }
  return base;
}
```

**Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

**Step 6: Commit**

```
feat(report-cards): soften blacklist scoring and add regulated-entity tier

Blacklist sub-factor: 100/66/33 (was 100/50/0).
Decentralization: auto-promote single-entity to regulated-entity (score 40
vs 20) when coin has named regulator, license, and independent audit.
```

---

### Task 3: Write tests

**Files:**
- Create: `src/lib/__tests__/report-cards.test.ts`

**Step 1: Write tests for blacklist scoring change**

```typescript
import { describe, it, expect } from "vitest";
import {
  scoreResilience,
  scoreDecentralization,
  resolveGovernanceQuality,
  GOVERNANCE_QUALITY_SCORE,
} from "../report-cards";
import type { StablecoinMeta } from "../types";

// Minimal meta helper
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test Coin",
    symbol: "TST",
    geckoId: null,
    cmcId: null,
    llamaId: null,
    peg: "USD",
    decimals: {},
    contracts: {},
    links: {},
    flags: { governance: "centralized", backing: "rwa-backed" },
    ...overrides,
  } as StablecoinMeta;
}

describe("scoreResilience — blacklist sub-factor", () => {
  const meta = makeMeta();

  it("scores 33 for blacklistable coins (was 0)", () => {
    const result = scoreResilience(meta, true);
    expect(result.detail).toContain("Blacklist: Yes (33)");
  });

  it("scores 66 for possibly blacklistable coins (was 50)", () => {
    const result = scoreResilience(meta, "possible");
    expect(result.detail).toContain("Blacklist: Possible (mutable contract) (66)");
  });

  it("scores 100 for non-blacklistable coins", () => {
    const result = scoreResilience(meta, false);
    expect(result.detail).toContain("Blacklist: No (100)");
  });
});
```

**Step 2: Write tests for regulated-entity inference**

```typescript
describe("resolveGovernanceQuality — regulated-entity auto-promotion", () => {
  it("promotes to regulated-entity when regulator + license + independent-audit", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com", provider: "Deloitte" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("regulated-entity");
  });

  it("stays single-entity when regulator is missing", () => {
    const meta = makeMeta({
      jurisdiction: { country: "BVI" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("stays single-entity when PoR is self-reported", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "self-reported", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("stays single-entity when no PoR at all", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("does not promote decentralized governance", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed" },
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("decentralized", meta)).toBe("dao-governance");
  });

  it("respects explicit governanceQuality override", () => {
    const meta = makeMeta({
      governanceQuality: "single-entity",
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });
});

describe("GOVERNANCE_QUALITY_SCORE", () => {
  it("scores regulated-entity at 40", () => {
    expect(GOVERNANCE_QUALITY_SCORE["regulated-entity"]).toBe(40);
  });

  it("scores single-entity at 20", () => {
    expect(GOVERNANCE_QUALITY_SCORE["single-entity"]).toBe(20);
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/lib/__tests__/report-cards.test.ts`
Expected: All tests PASS.

**Step 4: Commit**

```
test(report-cards): add tests for blacklist scoring and regulated-entity inference
```

---

### Task 4: Update documentation

**Files:**
- Modify: `docs/report-cards.md`

**Step 1: Update the resilience sub-factor table**

Find the blacklist scoring description and update the values from 100/50/0 to 100/66/33.

**Step 2: Update the decentralization section**

Add `regulated-entity` (40) to the governance quality tiers table. Document the auto-promotion criteria: jurisdiction with regulator + license + independent-audit PoR.

**Step 3: Bump methodology version**

If the doc references a methodology version, note this is v5.1.

**Step 4: Commit**

```
docs: update report-cards methodology for v5.1 scoring changes
```

---

### Task 5: Update methodology version in code

**Files:**
- Modify: `src/lib/report-cards.ts:32`

**Step 1: Bump version**

Change:
```typescript
export const METHODOLOGY_VERSION = "5.0";
```
To:
```typescript
export const METHODOLOGY_VERSION = "5.1";
```

**Step 2: Build and type-check**

Run: `npm run build`
Expected: PASS (clean build).

**Step 3: Commit**

```
chore: bump report-card methodology to v5.1
```
