---
title: "Add tests for stablecoin-id-registry and URL helper"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Prerequisites

- TICKET-002, TICKET-003, and TICKET-004 must all be completed first (registry module, URL helper, and llamaId population)

## Goal

Add comprehensive Vitest tests for the new registry module and URL builder to lock in their behavior before the migration proceeds.

## Task

### 1. Create `shared/lib/__tests__/stablecoin-id-registry.test.ts`

Note: this will be the first test file under `shared/lib/__tests__/`. Create the directory if it doesn't exist.

Use the project's test conventions (see existing tests like `src/lib/__tests__/format.test.ts` for style):

```ts
import { describe, it, expect } from "vitest";
import {
  REGISTRY_BY_ID,
  REGISTRY_BY_LLAMA_ID,
  REGISTRY_BY_GECKO_ID,
  REGISTRY_BY_CMC_SLUG,
  resolveStablecoinId,
  resolveByExternalId,
  getLlamaId,
} from "@shared/lib/stablecoin-id-registry";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { SHADOW_STABLECOINS } from "@shared/lib/shadow-stablecoins";
```

**Test cases (group with `describe` blocks):**

`describe("REGISTRY_BY_ID")`:
- `it("contains all tracked stablecoins")` -- `REGISTRY_BY_ID.size` >= `TRACKED_STABLECOINS.length`
- `it("contains shadow stablecoins")` -- check `REGISTRY_BY_ID.has("3")` (UST) and `REGISTRY_BY_ID.has("iron-finance")` (these are still the pre-Phase 3 IDs)
- `it("has no duplicate canonical IDs")` -- the map built without throwing is proof; just assert `REGISTRY_BY_ID.size === TRACKED_STABLECOINS.length + SHADOW_STABLECOINS.length`
- `it("module loads without duplicate-key assertion errors")` -- importing the module is the test; if it throws, the test fails

`describe("REGISTRY_BY_LLAMA_ID")`:
- `it("maps numeric llamaId to meta")` -- check `REGISTRY_BY_LLAMA_ID.get("1")?.symbol === "USDT"` (after TICKET-004 populates llamaId)
- `it("has no duplicate llamaIds")` -- assert the map size equals the count of entries with llamaId set

`describe("resolveStablecoinId")`:
- `it("resolves canonical ID directly")` -- `resolveStablecoinId("1")` returns `{ canonicalId: "1", matchedBy: "canonical" }`
- `it("resolves llamaId when allowLegacy is true")` -- `resolveStablecoinId("1", { allowLegacy: true })` returns with `matchedBy: "canonical"` or `"llama"` (since "1" is both the id and llamaId currently, it matches canonical first)
- `it("returns null for unknown ID")` -- `resolveStablecoinId("nonexistent-id-99999")` returns `null`
- `it("returns null for llamaId when allowLegacy is false")` -- This test is only meaningful post-Phase 3 when IDs change; for now, add a test with a clearly-non-canonical input like `"99999"` that returns null

`describe("REGISTRY_BY_CMC_SLUG")`:
- `it("maps cmcSlug to meta")` -- currently only JupUSD has `cmcSlug: "jupusd"`, check `REGISTRY_BY_CMC_SLUG.get("jupusd")?.symbol === "JUPUSD"`
- `it("skips entries without cmcSlug")` -- `REGISTRY_BY_CMC_SLUG.size` should be much less than `TRACKED_STABLECOINS.length` (currently only 1 entry has cmcSlug)

`describe("resolveByExternalId")`:
- `it("resolves defillama ID")` -- `resolveByExternalId("defillama", "1")?.symbol === "USDT"` (after TICKET-004 populates llamaId)
- `it("resolves coingecko ID")` -- `resolveByExternalId("coingecko", "tether")?.symbol === "USDT"` (USDT has `geckoId: "tether"`)
- `it("resolves cmc slug")` -- `resolveByExternalId("cmc", "jupusd")?.symbol === "JUPUSD"` (JupUSD is currently the only entry with `cmcSlug`)
- `it("returns null for unknown external ID")` -- `resolveByExternalId("defillama", "999999")` returns `null`
- `it("returns null for unknown provider value cast to any")` -- optional, just ensuring type exhaustiveness

`describe("getLlamaId")`:
- `it("returns llamaId for a tracked stablecoin")` -- `getLlamaId("1")` returns `"1"` (USDT's id is "1" and after TICKET-004 its llamaId is also "1")
- `it("returns null for CoinGecko-sourced stablecoin")` -- `getLlamaId("cg-ustb")` returns `null` (no llamaId on CG-only entries)
- `it("returns null for non-existent ID")` -- `getLlamaId("does-not-exist")` returns `null`

`describe("DEAD_BY_LLAMA_ID")`:
- `it("maps dead stablecoin llamaIds to names")` -- `DEAD_BY_LLAMA_ID.size` should be > 0 (roughly 20 dead stablecoins have llamaId)
- `it("skips dead stablecoins without llamaId")` -- `DEAD_BY_LLAMA_ID.size` should be less than the total dead stablecoin count

### 2. Create `src/lib/__tests__/urls.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildStablecoinUrl } from "@/lib/urls";
```

**Test cases:**

`describe("buildStablecoinUrl")`:
- `it("returns correct path for simple ID")` -- `buildStablecoinUrl("1")` returns `"/stablecoin/1/"`
- `it("returns correct path for prefixed ID")` -- `buildStablecoinUrl("cg-ustb")` returns `"/stablecoin/cg-ustb/"`
- `it("encodes special characters")` -- `buildStablecoinUrl("usdt-tether")` returns `"/stablecoin/usdt-tether/"` (no encoding needed for hyphens)
- `it("encodes spaces and unusual characters")` -- `buildStablecoinUrl("foo bar")` returns `"/stablecoin/foo%20bar/"`

### Important notes

- Use Vitest (`import { describe, it, expect } from "vitest"`)
- Use path aliases (`@shared/lib/...` for shared modules, `@/lib/...` for src modules) -- see `vitest.config.ts` for alias configuration
- Do NOT import from relative paths like `../stablecoin-id-registry` -- use the aliases
- All test file names must end in `.test.ts`

## Acceptance Criteria

- `npm test` exits 0 with all new tests passing
- `npm test -- --reporter=verbose 2>&1 | grep 'stablecoin-id-registry'` shows passing tests
- `npm test -- --reporter=verbose 2>&1 | grep 'urls'` shows passing tests
- Both test files exist at their specified paths
