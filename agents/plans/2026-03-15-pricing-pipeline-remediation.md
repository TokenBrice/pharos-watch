# Pricing Pipeline Remediation & Densification Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all bugs, mitigate design risks, expand source coverage, and add tests identified in the 2026-03-15 pricing pipeline audit.

**Architecture:** Single-pass remediation across 4 domains: (1) bug fixes in enrichment/validation code, (2) Pyth staleness guard + Curve sanity bound, (3) source coverage expansion via metadata + allowlist updates, (4) test coverage for untested paths. All changes are backward-compatible and require no schema migrations.

**Tech Stack:** TypeScript strict, Vitest, Cloudflare Workers, Zod, shared/lib metadata

**Audit reference:** `agents/audits/pricing-pipeline-audit-2026-03-15.md`

---

## Deferred Items

The following audit findings are intentionally deferred:

- **BUG-2 (DL sentinel price):** The constant price `1.0000937289875413` affecting rwausdi-multipli and zeusd-zoth originates from DefiLlama's upstream data — not a bug in our code. Both coins are single-source regardless. No code fix possible without a DL API change.
- **6.6 (Missing geckoIds for M, rwaUSDi, USDU):** CoinGecko does not list these tokens (verified via API search). M (m0) and rwaUSDi return zero results; USDU maps to "uncap-usd" (different project). These coins cannot gain geckoIds until CoinGecko adds them. Revisit periodically.
- **6.5 (Curve pool expansion), 6.7 (authoritative override expansion), 6.8 (DexScreener budget increase):** Rated LOW impact by audit. Deferred to a follow-up.
- **Test gaps 7.3 (integration test, Curve hop e2e, network errors, malformed responses, RedStone venue agreement, DexScreener budget exhaustion):** These 6 test gaps require substantial mocking infrastructure. Deferred to a dedicated test-hardening pass.

---

## File Structure

### Modified files

| File | Responsibility | Changes |
|------|----------------|---------|
| `worker/src/cron/enrich-prices.ts` | Price orchestration | BUG-1: CMC slug-based matching + type fix; BUG-3: DexScreener budget guard |
| `worker/src/lib/pyth.ts` | Pyth Hermes client | RISK-3: publishTime staleness rejection |
| `worker/src/lib/curve-onchain.ts` | Curve on-chain pricing | RISK-4: commodity-aware sanity bound |
| `worker/src/lib/cex-tickers.ts` | CEX ticker clients | Add HONEY to Coinbase allowlist |
| `worker/src/lib/redstone.ts` | RedStone client | Add sUSDe to allowlist |
| `shared/lib/stablecoins/usd-minor.ts` | Stablecoin metadata | Add pythFeedId for LUSD, HONEY; add cmcSlug for collision group coins |
| `shared/lib/stablecoins/usd-major.ts` | Stablecoin metadata | Add pythFeedId for USR; add cmcSlug for collision group coins |
| `docs/pricing-pipeline.md` | Pipeline docs | DexScreener budget/cap, staleness guard, CMC slug matching |

### Modified test files

| File | Changes |
|------|---------|
| `worker/src/cron/__tests__/enrich-prices.test.ts` | CMC slug collision test |
| `worker/src/lib/__tests__/pyth.test.ts` | Fix existing stale publish_time; add staleness rejection tests |
| `worker/src/lib/__tests__/curve-onchain.test.ts` | Commodity sanity bound test |
| `worker/src/lib/__tests__/price-consensus.test.ts` | 50bps boundary edge case test |
| `worker/src/lib/__tests__/cex-tickers.test.ts` | Update COINBASE_KNOWN_SYMBOLS count assertion |

---

## Chunk 1: Bug Fixes

### Task 1: Fix CMC Symbol Collision (BUG-1)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:700-730`
- Modify: `shared/lib/stablecoins/usd-major.ts` (cmcSlug additions)
- Modify: `shared/lib/stablecoins/usd-minor.ts` (cmcSlug additions)
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

**Context:** The CMC fallback pass matches assets by `symbol.toUpperCase()`, which causes cross-contamination when 2+ tracked coins share the same symbol (11 collision groups, 22 coins). The fix has two parts: (a) add `cmcSlug` to metadata for all collision-group coins, and (b) update the CMC matching code to prefer slug-based lookup.

**Collision groups requiring cmcSlug:**

| ID | Symbol | cmcSlug |
|----|--------|---------|
| usdf-falcon | USDf | falcon-finance |
| usdf-astherus | USDF | astherus |
| cusd-cap | CUSD | cap-cusd |
| cusd-celo | cUSD | celo-dollar |
| usda-avalon | USDA | avalon-usda |
| usda-anzens | USDA | anzens-usda |
| dusd-standx | DUSD | standx-dusd |
| dusd-dtrinity | dUSD | dtrinity-dusd |
| gusd-gate | GUSD | gatechain-token |
| gusd-gemini | GUSD | gemini-dollar |
| pusd-pleasing | PUSD | pleasing-usd |
| pusd-plume | pUSD | plume-usd |
| reusd-re-protocol | reUSD | re-protocol-reusd |
| reusd-resupply | REUSD | resupply-reusd |
| usdu-unitas | USDU | unitas-protocol |
| usdu-usdu-finance | USDU | usdu |
| usdp-paxos | USDP | pax-dollar |
| usdp-parallel | USDp | parallel-usdp |
| msusd-metronome | MSUSD | metronome-synth-usd |
| msusd-main-street | MSUSD | main-street-usd |
| usdm-mega | USDM | mega-usdm |
| usdm-moneta | USDM | moneta-usdm |

Note: CMC slugs will be validated during implementation by checking actual CMC API responses. The slugs above are best-guess based on CMC naming conventions — the implementing agent should verify against the CMC category endpoint response and adjust if needed.

- [ ] **Step 1: Add cmcSlug to collision group coins in usd-major.ts**

In `shared/lib/stablecoins/usd-major.ts`, add `cmcSlug` to these entries:

For `usd("usdf-falcon"` (~line 364), add after `geckoId: "falcon-finance"`:
```typescript
cmcSlug: "falcon-finance",
```

For `usd("cusd-cap"` (~line 896), add after `geckoId`:
```typescript
cmcSlug: "cap-cusd",
```

For `usd("usda-avalon"` (~line 1053), add after `geckoId`:
```typescript
cmcSlug: "avalon-usda",
```

- [ ] **Step 2: Add cmcSlug to collision group coins in usd-minor.ts**

In `shared/lib/stablecoins/usd-minor.ts`, add `cmcSlug` to these entries:

For `usd("usdf-astherus"` (~line 164):
```typescript
cmcSlug: "astherus",
```

For `usd("dusd-standx"` (~line 187):
```typescript
cmcSlug: "standx-dusd",
```

For `usd("gusd-gate"` (~line 242):
```typescript
cmcSlug: "gatechain-token",
```

For `usd("pusd-pleasing"` (~line 372):
```typescript
cmcSlug: "pleasing-usd",
```

For `usd("reusd-re-protocol"` (~line 392):
```typescript
cmcSlug: "re-protocol-reusd",
```

For `usd("usdu-unitas"` (~line 534):
```typescript
cmcSlug: "unitas-protocol",
```

For `usd("reusd-resupply"` (~line 697):
```typescript
cmcSlug: "resupply-reusd",
```

For `usd("gusd-gemini"` (~line 717):
```typescript
cmcSlug: "gemini-dollar",
```

For `usd("usdp-paxos"` (~line 739):
```typescript
cmcSlug: "pax-dollar",
```

For `usd("msusd-metronome"` (~line 1483):
```typescript
cmcSlug: "metronome-synth-usd",
```

For `usd("cusd-celo"` (~line 1840):
```typescript
cmcSlug: "celo-dollar",
```

For `usd("usdm-mega"` (~line 1803):
```typescript
cmcSlug: "mega-usdm",
```

For `usd("msusd-main-street"` (~line 1992):
```typescript
cmcSlug: "main-street-usd",
```

For `usd("usdm-moneta"` (~line 2014):
```typescript
cmcSlug: "moneta-usdm",
```

For `usd("usda-anzens"` (~line 2059):
```typescript
cmcSlug: "anzens-usda",
```

For `usd("pusd-plume"` (~line 2145):
```typescript
cmcSlug: "plume-usd",
```

For `usd("usdu-usdu-finance"` (~line 2322):
```typescript
cmcSlug: "usdu",
```

For `usd("dusd-dtrinity"` (~line 2346):
```typescript
cmcSlug: "dtrinity-dusd",
```

For `usd("usdp-parallel"` (~line 2554):
```typescript
cmcSlug: "parallel-usdp",
```

- [ ] **Step 3: Write failing test for CMC slug-based matching**

Add to `enrich-prices.test.ts`:

```typescript
describe("enrichMissingPrices — CMC symbol collision", () => {
  it("uses cmcSlug when available instead of symbol matching", async () => {
    // Two coins share symbol "CUSD" but have different cmcSlugs
    const assets: PeggedAsset[] = [
      { id: "cusd-cap", name: "Cap CUSD", symbol: "CUSD", cmcSlug: "cap-cusd", pegType: "peggedUSD" },
      { id: "cusd-celo", name: "Celo Dollar", symbol: "CUSD", cmcSlug: "celo-dollar", pegType: "peggedUSD" },
    ];

    // Mock: DL contracts fail (no address), CMC returns both slugs
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("coinmarketcap.com")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              coins: [
                { symbol: "CUSD", slug: "cap-cusd", quote: { USD: { price: 0.95 } } },
                { symbol: "CUSD", slug: "celo-dollar", quote: { USD: { price: 1.01 } } },
              ],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = mockD1({ getCache: null, setCache: true });
    await enrichMissingPrices(assets, "test-cmc-key", db);

    // Each coin should get its own slug-matched price, not the symbol collision value
    expect(assets[0].price).toBeCloseTo(0.95, 2);
    expect(assets[1].price).toBeCloseTo(1.01, 2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts -t "CMC symbol collision"`
Expected: FAIL — both coins get $1.01 (second symbol match overwrites first in the Map)

- [ ] **Step 5: Implement CMC slug-based matching**

In `enrich-prices.ts`, first update the type annotation at line 701-703:

```typescript
const cmcData = (await cmcRes.json()) as {
  data: { coins: Array<{ symbol: string; slug?: string; quote: { USD: { price: number } } }> };
};
```

Then replace the matching logic at lines 705-728:

```typescript
const cmcBySlug = new Map<string, number>();
const cmcBySymbol = new Map<string, number>();
for (const entry of cmcData.data.coins) {
  const price = entry.quote?.USD?.price;
  if (price != null && price > 0) {
    if (entry.slug) {
      cmcBySlug.set(entry.slug, price);
    }
    const sym = entry.symbol.toUpperCase();
    if (cmcBySymbol.has(sym)) {
      console.warn(`[enrich] CMC symbol collision: ${sym} (existing=$${cmcBySymbol.get(sym)}, new=$${price})`);
    }
    if (!cmcBySymbol.has(sym)) {
      cmcBySymbol.set(sym, price);
    }
  }
}

for (const m of missingAfterPass1b) {
  // Prefer cmcSlug-based match to avoid symbol collisions
  const cmcPrice = m.asset.cmcSlug
    ? cmcBySlug.get(m.asset.cmcSlug)
    : cmcBySymbol.get(m.asset.symbol.toUpperCase());
  if (cmcPrice != null && isReasonablePrice(
    cmcPrice,
    m.asset.pegType as string | undefined,
    fxRates,
    buildPriceReasonablenessOptions(m.asset),
  )) {
    applyResolvedPrice(assets[m.index], cmcPrice, "coinmarketcap", "fallback");
    passCmcCount++;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/enrich-prices.test.ts -t "CMC symbol collision"`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts shared/lib/stablecoins/usd-major.ts shared/lib/stablecoins/usd-minor.ts
git commit -m "fix: use cmcSlug for CMC fallback matching to avoid symbol collisions (BUG-1)

Add cmcSlug metadata for all 22 coins in 11 collision groups.
Update CMC matching to prefer slug-based lookup over symbol-based."
```

---

### Task 2: Fix DexScreener Budget Timer Race (BUG-3)

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:769-783`

**Context:** The 200ms sleep between DexScreener searches runs before the budget check, so budget can go negative by up to 200ms. The fix is to swap the order: check budget first, then sleep. This is a minor ordering fix — no new test needed (the existing test coverage is adequate for this one-line swap, and a proper budget-exhaustion test requires `Date.now()` mocking infrastructure that is deferred to the test-hardening pass).

- [ ] **Step 1: Swap budget check and sleep**

In `enrich-prices.ts`, reorder the block inside the DexScreener loop. Change from:

```typescript
if (idx > 0) {
  await sleepWithSignal(200, signal);
}

const remainingBudgetMs = dexBudgetDeadlineMs - Date.now();
if (remainingBudgetMs <= 0) {
```

To:

```typescript
const remainingBudgetMs = dexBudgetDeadlineMs - Date.now();
if (remainingBudgetMs <= 0) {
  console.warn(
    `[enrich] DexScreener pass budget exhausted after ${dexAttempts}/${dexCandidates.length} searches`,
  );
  break;
}

if (idx > 0) {
  await sleepWithSignal(200, signal);
}
```

Also remove the duplicate `console.warn` + `break` that was previously inside the budget check block (it moves up).

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "fix: check DexScreener budget before sleep to prevent negative budget (BUG-3)"
```

---

## Chunk 2: Risk Mitigations

### Task 3: Add Pyth publishTime Staleness Guard (RISK-3)

**Files:**
- Modify: `worker/src/lib/pyth.ts:60-82`
- Test: `worker/src/lib/__tests__/pyth.test.ts`

**Context:** Pyth feeds include `publishTime` but we never check it. A stale Pyth price (e.g., from a paused feed) could enter consensus as if it were fresh. Add a 5-minute staleness threshold.

**IMPORTANT:** The existing test at `pyth.test.ts:14` uses a hardcoded `publish_time: 1710000000` (March 2024 — over 2 years old). After implementing the staleness guard, this existing test will fail because the timestamp is far beyond 5 minutes. The existing test must be updated FIRST.

- [ ] **Step 1: Fix existing test's stale publish_time**

In `pyth.test.ts`, update the first test case. Change:
```typescript
price: { price: "100013000", expo: -8, conf: "61000", publish_time: 1710000000 },
```
To:
```typescript
price: { price: "100013000", expo: -8, conf: "61000", publish_time: Math.floor(Date.now() / 1000) - 60 },
```

- [ ] **Step 2: Write new staleness tests**

Add to `pyth.test.ts`:

```typescript
it("rejects feeds where publishTime is older than 5 minutes", async () => {
  const stalePublishTime = Math.floor(Date.now() / 1000) - 600; // 10 min old
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      parsed: [
        {
          id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
          price: { price: "100013000", expo: -8, conf: "61000", publish_time: stalePublishTime },
        },
      ],
    }),
  }));

  const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
  const results = await fetchPythPrices(feedIds);
  expect(results.size).toBe(0);
});

it("accepts feeds where publishTime is within 5 minutes", async () => {
  const freshPublishTime = Math.floor(Date.now() / 1000) - 120; // 2 min old
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      parsed: [
        {
          id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
          price: { price: "100013000", expo: -8, conf: "61000", publish_time: freshPublishTime },
        },
      ],
    }),
  }));

  const feedIds = new Map([["usdt-tether", "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b"]]);
  const results = await fetchPythPrices(feedIds);
  expect(results.size).toBe(1);
});
```

- [ ] **Step 3: Run "rejects stale" test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/pyth.test.ts -t "rejects feeds where publishTime"`
Expected: FAIL — stale price is currently accepted

- [ ] **Step 4: Implement staleness guard**

In `pyth.ts`, add constant at the top of the file (after `HERMES_BASE`):

```typescript
/** Maximum age (seconds) for Pyth publishTime before we discard the price */
const PYTH_MAX_STALENESS_SEC = 300; // 5 minutes
```

Then inside the feed processing loop, after `if (price <= 0) continue;` (line ~73), add:

```typescript
// Reject stale feeds
const nowSec = Math.floor(Date.now() / 1000);
if (nowSec - feed.price.publish_time > PYTH_MAX_STALENESS_SEC) {
  console.warn(`[pyth] Stale feed for ${coinId}: publishTime=${feed.price.publish_time}, age=${nowSec - feed.price.publish_time}s`);
  continue;
}
```

- [ ] **Step 5: Run all Pyth tests**

Run: `cd worker && npx vitest run src/lib/__tests__/pyth.test.ts`
Expected: All pass (including both new tests and the updated existing test)

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/pyth.ts worker/src/lib/__tests__/pyth.test.ts
git commit -m "fix: reject stale Pyth feeds older than 5 minutes (RISK-3)"
```

---

### Task 4: Fix Curve On-Chain Price Sanity Bound for Commodities (RISK-4)

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts:84,104`
- Test: `worker/src/lib/__tests__/curve-onchain.test.ts`

**Context:** The `impliedPrice < 100` sanity guard would silently drop valid gold prices (~$2900). While no commodity pools are currently configured, the guard should be future-proof. Raise to `< 10_000`.

- [ ] **Step 1: Write failing test**

Add to `curve-onchain.test.ts`. Note: the existing tests mock `fetchEvmCallHexAtBlock` (imported from `evm-rpc.ts`). Match the existing mock pattern in the file.

```typescript
it("accepts implied prices up to 10000 (commodity-safe bound)", async () => {
  // Simulate get_dy returning 0.000345 output tokens for 1 input token
  // impliedPrice = 1/0.000345 ≈ 2899 (gold-like price)
  const outputRaw = BigInt(345); // 345 with 6 decimals = 0.000345
  const resultHex = "0x" + outputRaw.toString(16).padStart(64, "0");

  mockEvmCall.mockResolvedValue(resultHex);

  const configs: CurvePoolConfig[] = [{
    stablecoinId: "xaut-test",
    poolAddress: "0x1234567890abcdef1234567890abcdef12345678",
    inputIndex: 0,
    outputIndex: 1,
    inputDecimals: 6,
    outputDecimals: 6,
    chain: "ethereum",
  }];

  const results = await fetchCurveOnchainPrices(configs);
  expect(results.has("xaut-test")).toBe(true);
  const price = results.get("xaut-test")!;
  expect(price).toBeGreaterThan(100);
  expect(price).toBeLessThan(5000);
});
```

(Adapt mock variable name `mockEvmCall` to match whatever the existing test file uses for mocking `fetchEvmCallHexAtBlock`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts -t "commodity-safe"`
Expected: FAIL — current `< 100` guard drops the price

- [ ] **Step 3: Raise sanity bound**

In `curve-onchain.ts`, change both sanity checks:

Line 84 — change:
```typescript
if (impliedPrice > 0 && impliedPrice < 100) {
```
To:
```typescript
if (impliedPrice > 0 && impliedPrice < 10_000) {
```

Line 104 — change:
```typescript
if (finalPrice > 0 && finalPrice < 100) {
```
To:
```typescript
if (finalPrice > 0 && finalPrice < 10_000) {
```

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/curve-onchain.ts worker/src/lib/__tests__/curve-onchain.test.ts
git commit -m "fix: raise Curve on-chain sanity bound to 10K for commodity tokens (RISK-4)"
```

---

## Chunk 3: Source Coverage Expansion

### Task 5: Add New Pyth Feed IDs to Metadata

**Files:**
- Modify: `shared/lib/stablecoins/usd-minor.ts` (LUSD at ~line 1013, HONEY at ~line 1174)
- Modify: `shared/lib/stablecoins/usd-major.ts` (USR at ~line 920)

**Context:** Research confirmed 3 new Pyth feeds available on Hermes for tracked coins that don't currently have `pythFeedId`:
- LUSD (lusd-liquity): `0xc9dc99720306ef43fd301396a6f8522c8be89c6c77e8c27d87966918a943fd20`
- USR (usr-resolv): `0x10b013adec14c0fe839ca0fe54cec9e4d0b6c1585ac6d7e70010dac015e57f9c`
- HONEY (honey-berachain): `0xf67b033925d73d43ba4401e00308d9b0f26ab4fbd1250e8b5407b9eaade7e1f4`

Each new feed adds a weight-2 voice to consensus, promoting these coins from 2-source (CG+DL) to 3-source.

- [ ] **Step 1: Add pythFeedId for LUSD**

In `shared/lib/stablecoins/usd-minor.ts`, find the `usd("lusd-liquity"` entry (~line 1013). Add `pythFeedId` on the line after `geckoId: "liquity-usd"`:

```typescript
pythFeedId: "0xc9dc99720306ef43fd301396a6f8522c8be89c6c77e8c27d87966918a943fd20",
```

- [ ] **Step 2: Add pythFeedId for HONEY**

In `shared/lib/stablecoins/usd-minor.ts`, find the `usd("honey-berachain"` entry (~line 1174). Add `pythFeedId` on the line after `geckoId: "honey-3"`:

```typescript
pythFeedId: "0xf67b033925d73d43ba4401e00308d9b0f26ab4fbd1250e8b5407b9eaade7e1f4",
```

- [ ] **Step 3: Add pythFeedId for USR**

In `shared/lib/stablecoins/usd-major.ts`, find the `usd("usr-resolv"` entry (~line 920). Add `pythFeedId` on the line after `geckoId: "resolv-usr"`:

```typescript
pythFeedId: "0x10b013adec14c0fe839ca0fe54cec9e4d0b6c1585ac6d7e70010dac015e57f9c",
```

- [ ] **Step 4: Run build + tests**

Run: `npm run build && npm test`
Expected: All pass (metadata additions are additive)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/stablecoins/usd-minor.ts shared/lib/stablecoins/usd-major.ts
git commit -m "feat: add Pyth feed IDs for LUSD, USR, HONEY (coverage expansion)"
```

---

### Task 6: Add sUSDe to RedStone Allowlist

**Files:**
- Modify: `worker/src/lib/redstone.ts:20-51`

**Context:** Research confirmed `sUSDe` returns valid prices from RedStone (`$1.22`). It's a NAV token (wrapped USDe) tracked as `susde-ethena`. Adding it to the allowlist gives it a RedStone voice in consensus. No test update needed — RedStone tests don't assert allowlist count.

- [ ] **Step 1: Add sUSDe to REDSTONE_TRACKED_SYMBOL_ALLOWLIST**

In `worker/src/lib/redstone.ts`, the allowlist is sorted case-sensitively (uppercase first, then lowercase). Add `"sUSDe"` after the lowercase entries. Looking at the current list, it ends with `"crvUSD"` then `"fxUSD"`. Insert `"sUSDe"` in the correct sort position — between `"fxUSD"` and the end, or more precisely alphabetically among the lowercase-starting entries:

Current lowercase entries: `"crvUSD"`, `"fxUSD"`. Add `"sUSDe"` between them:
```typescript
  "crvUSD",
  "fxUSD",
  "sUSDe",
```

Wait — `s` comes after `f`, so it goes after `fxUSD`:

```typescript
  "crvUSD",
  "fxUSD",
  "sUSDe",
] as const;
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/redstone.ts
git commit -m "feat: add sUSDe to RedStone allowlist (coverage expansion)"
```

---

### Task 7: Add HONEY to Coinbase Known Symbols

**Files:**
- Modify: `worker/src/lib/cex-tickers.ts:29-31`
- Modify: `worker/src/lib/__tests__/cex-tickers.test.ts`

**Context:** Research confirmed `HONEY-USD` is an active product on Coinbase Exchange. Adding it gives honey-berachain a Coinbase price voice (weight-2) in consensus. Combined with the new Pyth feed (Task 5), HONEY could go from 2-source to 4-source.

- [ ] **Step 1: Add HONEY to COINBASE_KNOWN_SYMBOLS**

In `worker/src/lib/cex-tickers.ts`, update the array:

```typescript
export const COINBASE_KNOWN_SYMBOLS: readonly string[] = [
  "USDT", "DAI", "PAXG", "USDS", "USD1", "HONEY",
] as const;
```

- [ ] **Step 2: Update test assertion**

In `worker/src/lib/__tests__/cex-tickers.test.ts`, update the lower bound in the count assertion:

```typescript
it("has a reasonable number of entries (5-25)", () => {
  expect(COINBASE_KNOWN_SYMBOLS.length).toBeGreaterThanOrEqual(6);
  expect(COINBASE_KNOWN_SYMBOLS.length).toBeLessThanOrEqual(25);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/cex-tickers.ts worker/src/lib/__tests__/cex-tickers.test.ts
git commit -m "feat: add HONEY to Coinbase known symbols (coverage expansion)"
```

---

## Chunk 4: Test Coverage & Documentation

### Task 8: Add 50bps Consensus Boundary Edge Case Test

**Files:**
- Modify: `worker/src/lib/__tests__/price-consensus.test.ts`

**Context:** The audit identified that the exact 50bps boundary (49.9bps vs 50.1bps) is untested. These are regression tests — no code change, just confirming existing behavior.

- [ ] **Step 1: Add boundary tests**

Add to `price-consensus.test.ts`:

```typescript
it("treats sources within 50bps of each other as agreeing (inclusive threshold)", () => {
  // Two prices ~49.9bps apart: 1.0000 and 1.0050
  // Mid = 1.0025, diff = 0.005, bps = 0.005/1.0025 * 10000 ≈ 49.88
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.0000, weight: 1 },
    { source: "defillama", price: 1.0050, weight: 1 },
  ];
  const result = computePriceConsensus(sources, 1.0, 50);
  expect(result!.confidence).toBe("high");
});

it("treats sources beyond 50bps of each other as disagreeing", () => {
  // Two prices ~59.8bps apart: 1.0000 and 1.0060
  // Mid = 1.003, diff = 0.006, bps = 0.006/1.003 * 10000 ≈ 59.8
  const sources: SourcePrice[] = [
    { source: "coingecko", price: 1.0000, weight: 1 },
    { source: "defillama", price: 1.0060, weight: 1 },
  ];
  const result = computePriceConsensus(sources, 1.0, 50);
  expect(result!.confidence).toBe("low");
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/price-consensus.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/__tests__/price-consensus.test.ts
git commit -m "test: add 50bps consensus boundary edge case tests"
```

---

### Task 9: Update Pricing Pipeline Documentation

**Files:**
- Modify: `docs/pricing-pipeline.md`

**Context:** The audit found the docs don't mention the DexScreener 45-second budget, 10-search cap, the new Pyth staleness guard, or CMC slug matching. Update the docs to cover all changes in this plan.

- [ ] **Step 1: Read current docs**

Read: `docs/pricing-pipeline.md` (full file)

- [ ] **Step 2: Add DexScreener budget documentation**

In the "Fallback Enrichment" section, after the DexScreener pass description, add:

```markdown
**DexScreener budget:** Pass 3 is time-bounded to 45 seconds total (`DEXSCREENER_PASS_BUDGET_MS`). At most 10 search queries are attempted (`DEXSCREENER_MAX_SEARCHES`), with 200ms delays between requests. If the budget is exhausted before all candidates are tried, the pass exits gracefully. Only pools with >$50K USD liquidity are considered.
```

- [ ] **Step 3: Add Pyth staleness guard documentation**

In the "Pyth Hermes" source description/row, add:

```markdown
Pyth feeds are rejected if `publishTime` is more than 5 minutes old (`PYTH_MAX_STALENESS_SEC = 300`). This prevents stale or paused oracle data from entering consensus.
```

- [ ] **Step 4: Add CMC slug matching note**

In the CMC/Pass 2 section, add:

```markdown
CMC matching prefers `cmcSlug`-based lookup when available to avoid symbol collisions (11 collision groups share case-insensitive symbols across 22 tracked coins). Falls back to symbol-based matching for coins without a `cmcSlug`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/pricing-pipeline.md
git commit -m "docs: add DexScreener budget, Pyth staleness, CMC slug matching docs"
```

---

### Task 10: Final Build Verification

- [ ] **Step 1: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Clean build, no type errors

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: Clean

- [ ] **Step 4: Verify doc count guard**

Run: `npm run check:doc-counts`
Expected: Pass (no stablecoin count changes)
