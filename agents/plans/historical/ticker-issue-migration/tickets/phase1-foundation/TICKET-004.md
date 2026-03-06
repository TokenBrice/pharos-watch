---
title: "Populate llamaId and detailProvider on all master list entries"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Add `llamaId` and `detailProvider` values to every entry in the two active stablecoin lists so the registry can resolve legacy IDs.

## Prerequisites

TICKET-001 must be applied first (adds `llamaId` and `detailProvider` to `StablecoinMeta` and `StablecoinOpts`).

## Task

This is a mechanical but large change (~150 entries across 2 files). Do NOT change any `id` field — only add the new `llamaId` and `detailProvider` fields.

### 1. `shared/lib/stablecoins.ts` -- TRACKED_STABLECOINS (148 entries)

**Numeric-ID entries (129 entries):** These have IDs like `"1"`, `"2"`, `"119"`, etc. For each, add both fields to the `opts` object:
```ts
// Example: usd("1", "Tether", "USDT", ..., { llamaId: "1", detailProvider: "defillama", ... })
```
The `llamaId` value is identical to the current `id` value. The `detailProvider` is `"defillama"`.

**CoinGecko-prefix entries (12 entries):** These have IDs like `"cg-ustb"`, `"cg-ousg"`, `"cg-jpyc"`, etc. For each, add only `detailProvider`:
```ts
// Example: usd("cg-ustb", ..., { detailProvider: "coingecko", ... })
```
No `llamaId` needed (these were never DefiLlama numeric IDs).

The complete list of `cg-*` entries (12 total): `cg-ustb`, `cg-ousg`, `cg-mtbill`, `cg-dinari-usd`, `cg-wrapped-savings-rusd`, `cg-jpyc`, `cg-eurq`, `cg-deuro`, `cg-zarp`, `cg-syrupusdc`, `cg-syrupusdt`, `cg-yousd`.

**Gold-prefix entries (6 entries):** `gold-xaut`, `gold-paxg`, `gold-kau`, `gold-xaum`, `gold-cgo`, `gold-dgld`. Add `detailProvider: "commodity"`. No `llamaId`.

**Silver-prefix entries (1 entry):** `silver-kag`. Add `detailProvider: "commodity"`. No `llamaId`.

### 2. `shared/lib/shadow-stablecoins.ts` -- SHADOW_STABLECOINS (2 entries)

- `id: "3"` (UST/TerraUSD): Add `llamaId: "3", detailProvider: "defillama"` to the inline object.
- `id: "iron-finance"` (IRON): Add `detailProvider: "coingecko"` only (no llamaId — it was never a DL numeric ID and has no DL stablecoin entry; it uses `geckoId: "iron-stablecoin"` for price data).

### 3. `shared/lib/dead-stablecoins.ts` -- DEAD_STABLECOINS (~78 entries)

Dead stablecoins use the `DeadStablecoin` type, which already has an optional `llamaId?: string` field (21 entries already have it populated). The `DeadStablecoin` type does NOT have `detailProvider` -- skip that field for dead coins (it is not needed since dead coins have no detail pages).

No changes needed to this file for TICKET-004.

### Important rules

- **Tracked entries** (using `usd()`/`eur()`/`other()` helpers): Place `llamaId` and `detailProvider` at the START of the opts object (right after the opening `{`), before existing fields like `geckoId`, `deploymentModel`, etc.
- **Shadow entries** (plain object literals): Place `llamaId` and `detailProvider` right after `id:` in the object literal, before `name:`.
- Do NOT change the `id` field on any entry.
- Do NOT change any other existing field values.
- Be thorough: every single entry must get its appropriate fields.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'llamaId: "' shared/lib/stablecoins.ts` returns 129 (numeric-ID entries only; cg-/gold-/silver- entries do not get llamaId; the quoted pattern excludes the `coin()` function's `llamaId: opts?.llamaId` line)
- `grep -c 'detailProvider: "' shared/lib/stablecoins.ts` returns 148 (every entry; the quoted pattern excludes the `coin()` function's `detailProvider: opts?.detailProvider` line)
- `grep -c 'llamaId:' shared/lib/shadow-stablecoins.ts` returns 1 (UST only)
- `grep -c 'detailProvider:' shared/lib/shadow-stablecoins.ts` returns 2 (UST = "defillama", IRON = "coingecko")
- No `id:` field values were changed (verify with `git diff --stat` showing only additions, no modifications to id lines)
