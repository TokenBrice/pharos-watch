# Blacklist Feature — Agent C Code Quality & Maintainability Audit

Date: 2026-04-16
Auditor: Agent C (Code Quality & Maintainability)
Scope: `/blacklist` feature (worker/shared/frontend), research-only.
Methodology: Surgical-changes principle — every recommendation must cite file + line range + current pain + concrete change + risk, and be justified by a readability or reliability improvement.

---

## Executive Summary (Top 10)

1. **[HIGH] `sync-blacklist.ts` duplicates ~15 lines of counter-merging twice** (tron branch vs. evm branch, lines 218–224 and 283–289). Collapse into a single `mergeProcessedCounters` helper or move the merge inside `processFetchedBlacklistRows` so the caller receives already-aggregated numbers.
2. **[HIGH] `parseEvmLogs` amount decoding is a 5-branch nested ternary** (`worker/src/cron/blacklist/evm-source.ts:159–171`). Readability is poor and mixed indentation makes it ambiguous. Extract to a `decodeLogAmount(eventDef, log, decimals, addressIndexed)` helper.
3. **[HIGH] `backfillAmounts` re-implements the destroy-receipt + historical-balance core of `enrichRowBalances`** (`amount-recovery.ts:346–412` vs `77–181`). The diverging SQL update bookkeeping makes the duplication tolerable, but the core "try receipt, then historical balance" sequence should be extracted to a small `resolveEvmAmount` helper.
4. **[HIGH] `BlacklistRow` type drift on `amount_attempt_count`** (`worker/src/cron/blacklist/shared.ts:24`). Declared as `number`, but the `backfillAmounts` SELECT returns `number | null` and the test fixture in `worker/src/api/__tests__/helpers/fixtures.ts` marks it optional. The DB column is nullable. Change to `number | null` on `BlacklistRow`.
5. **[HIGH] Enum fields on `BlacklistRow` are untyped `string`** (`shared.ts:8–12`: `event_type`, `amount_source`, `amount_status`). The shared `BlacklistEvent` wire type in `shared/types/market.ts:457` uses precise unions. Align the DB row type to the same unions so inserts/updates can't drift.
6. **[HIGH] `src/components/blacklist-table-logic.ts` is dead code** — only its own test file imports it. Table sorting is server-side (API `sortBy`/`sortDirection`); the client comparator has no runtime callers. The file plus its test can be removed.
7. **[HIGH] `src/app/blacklist/view-model.ts` returns `setSearchInput` but the page never consumes it**. It's part of the 30-field view-model surface for no functional reason. Remove from the return object.
8. **[MEDIUM] `blacklist-contracts.ts` naming inconsistency** — USDC topics use the `_TOPIC` suffix with the stablecoin-prefix convention (`USDC_BLACKLISTED_TOPIC`), but Hex Trust topics drop the prefix (`ADDED_BLACKLIST_TOPIC`, `REMOVED_BLACKLIST_TOPIC`). Low risk to fix but pays long-term dividends as the file grows.
9. **[MEDIUM] `persistence.ts` binds `row.amount_native` to both `amount` and `amount_native` columns** with no comment. `amount` is a legacy duplicate column that the TypeScript `BlacklistRow` doesn't declare. Add a 1-line `// legacy column …` comment so future readers don't think it's a bug.
10. **[MEDIUM] Several large event-family test gaps**: `parseEvmLogs` does not cover the `addressDataIndex`-only path, the indexed-address + non-indexed-amount `addressIndexed ? data≥66 : data.slice(66)` branch, or the A7A5 destroy amount-topic-zero fallback; `parseTronEvent` has **no dedicated tests** despite fallback-key logic (`_user`/`_blackListedUser`/`"0"`); backfill has no tests for `config_missing`, `ambiguous_config`, `budget_exhausted`, or `runtime_budget` failure classes.

---

## Critical

None. There are no observed data-integrity or correctness bugs in the audited code. The one previously-bad issue (zero-balance override for non-gold stablecoins) is already fixed and covered by a regression test in `current-balance-cache.test.ts:220–266`.

---

## High

### H1. `sync-blacklist.ts` — duplicated post-fetch counter merge

- **File:** `worker/src/cron/sync-blacklist.ts`
- **Lines:** 218–224 (tron) and 283–289 (evm)
- **Current pain:** Two identical 7-line blocks read:
  ```ts
  enrichCounters.attempted += processed.enrichCounters.attempted;
  enrichCounters.succeeded += processed.enrichCounters.succeeded;
  enrichCounters.failed   += processed.enrichCounters.failed;
  totalInsertedRows += processed.insertedRows;
  currentBalanceCacheCounters.updated += processed.currentBalanceCacheCounters.updated;
  currentBalanceCacheCounters.deleted += processed.currentBalanceCacheCounters.deleted;
  currentBalanceCacheCounters.failed  += processed.currentBalanceCacheCounters.failed;
  ```
  If a new counter is ever added, two sites must change. The prompt hint that lines 202–289 contain "its own post-fetch handling" is subtly wrong — the block already calls `processFetchedBlacklistRows` once per branch; the duplication is only in the counter merge.
- **Concrete change:** Add a private `mergeProcessed(counters, processed)` function at module scope (single-use, ~8 lines) and call it from both branches. Alternatively, move the counters into an object-at-closure that `processFetchedBlacklistRows` mutates directly — but that requires a bigger refactor and is not justified here.
- **Risk:** Very low. Pure refactor, trivially verified by running `sync-blacklist` tests.
- **Priority:** Safe to apply immediately.

### H2. `parseEvmLogs` — 5-branch nested-ternary amount decoding

- **File:** `worker/src/cron/blacklist/evm-source.ts`
- **Lines:** 159–171
- **Current pain:** The `const amount = eventDef.hasAmount ? … : null` expression has 5 mutually-exclusive branches (`amountTopicIndex`, `amountDataIndex`, `addressIndexed && data≥66`, `!addressIndexed && data>66`, null). The indentation in the file is inconsistent (the outer and inner ternaries are visually identical), making the fallthrough semantics easy to mis-read. An expression this long should be a function.
- **Concrete change:** Extract:
  ```ts
  function decodeEvmLogAmount(
    eventDef: BlacklistEventDef,
    log: EvmLogLike,
    decimals: number,
    addressIndexed: boolean,
  ): number | null { … }
  ```
  with 4 explicit early returns. ~20 lines, strictly an extraction — no behavior change.
- **Risk:** Low. Parsing is already unit-tested in `evm-source.test.ts`, and the tests would catch any regression. Worth running all `parseEvmLogs` tests after extraction.
- **Priority:** Safe to apply immediately.

### H3. `amount-recovery.ts` — `enrichRowBalances` vs `backfillAmounts` duplication

- **File:** `worker/src/cron/blacklist/amount-recovery.ts`
- **Lines:** 77–181 (`enrichRowBalances`) and 253–472 (`backfillAmounts`)
- **Current pain:** Both functions implement the same "if destroy, try receipt via `fetchDestroyAmountFromLog`; otherwise try `fetchEvmTokenBalance`" sequence (in-flight: lines 128–166; DB-pass: lines 346–412). The bodies are different enough (one mutates rows in place, the other appends D1 statements) that a full merge is not justified, but the *core amount lookup* is duplicated line-for-line.
- **Concrete change:** Extract a small helper:
  ```ts
  async function resolveEvmAmountForRow(args: {
    config: ContractEventConfig;
    eventType: string;
    txHash: string;
    address: string;
    blockNumber: number;
    etherscanApiKey: string | null;
    drpcApiKey: string | null;
    rateLimit: RateLimitedFetch;
    budget: SubrequestBudget;
    signal?: AbortSignal;
    chainRpcs?: Map<string, ChainRpcConfig>;
  }): Promise<{ amount: number | null; source: "event" | "historical_balance" }>
  ```
  Call it from both paths. Each caller still does its own bookkeeping (enrich updates row in memory; backfill stages a D1 update), but the actual lookup is no longer forked. ~50 fewer lines overall.
- **Risk:** Medium. Both paths matter for correctness; introducing a helper means editing two hot paths at once. Requires strong test coverage on `backfillAmounts` (currently **none** — see Test Gaps T6). Recommend: (a) add tests for `backfillAmounts` first, then (b) extract the helper in a follow-up.
- **Priority:** Requires discussion — only worth doing if the backfill test gap is closed first.

### H4. `BlacklistRow.amount_attempt_count` type drift

- **File:** `worker/src/cron/blacklist/shared.ts`
- **Line:** 24
- **Current pain:** `amount_attempt_count: number;` is not compatible with:
  - `amount-recovery.ts:288` — `amount_attempt_count: number | null` in the raw SELECT type
  - `remediate-blacklist-amount-gaps.ts:27` — same, `number | null`
  - `worker/src/api/__tests__/helpers/fixtures.ts:30` — `amount_attempt_count?: number` (optional)
  The DB column is nullable (`COALESCE(amount_attempt_count, 0) + 1` in updates proves this), and every production writer starts from 0 (evm-source.ts:121, tron-source.ts:88), so new rows are always non-null. But legacy rows written before this column existed can be `NULL`. The shared row type lies about this.
- **Concrete change:** Change the field to `number | null` on `BlacklistRow`, and update the two call sites (`evm-source.ts:121` and `tron-source.ts:88`) to continue writing `0`. Also drop the `amount_attempt_count?` optional from the test fixture so it matches.
- **Risk:** Very low. Only affects how TS narrows the type — no runtime change.
- **Priority:** Safe to apply immediately.

### H5. `BlacklistRow` enum drift on `event_type` / `amount_source` / `amount_status`

- **File:** `worker/src/cron/blacklist/shared.ts`
- **Lines:** 8–12
- **Current pain:** The DB row type declares `event_type: string`, `amount_source: string`, `amount_status: string`. Meanwhile `shared/types/market.ts:446–455` already defines the precise unions (`BlacklistEventType`, `BlacklistAmountSource`, `BlacklistAmountStatus`) used by the wire type. Nothing prevents a bug writing `"blaclist"` instead of `"blacklist"` — the compiler wouldn't catch it. The enrichment path in `amount-recovery.ts:111–113` even has a string-literal guard that a union type would make redundant.
- **Concrete change:** Import the three unions from `@shared/types/market` into `shared.ts` and retype:
  ```ts
  event_type: BlacklistEventType;
  amount_source: BlacklistAmountSource;
  amount_status: BlacklistAmountStatus;
  ```
  Then TypeScript narrows correctly in `parseEvmLogs`, `parseTronEvent`, `enrichRowBalances`, and `syncCurrentBalanceCacheForRows`. The `row.event_type !== "blacklist" && …` guard in `amount-recovery.ts:113` becomes a no-op check that can stay (belt-and-suspenders) or be removed.
- **Risk:** Low. Should surface 0-few existing mismatches at build time. Worth a worker `tsc --noEmit` run after the change.
- **Priority:** Safe to apply immediately.

### H6. `src/components/blacklist-table-logic.ts` is dead code

- **File:** `src/components/blacklist-table-logic.ts` + its test file
- **Current pain:** `compareBlacklistRows` has **zero runtime callers**. Grep confirms:
  - Only import: `src/components/__tests__/blacklist-table-logic.test.ts:2`
  - `src/components/blacklist-table.tsx` uses server-side sort via `onSortChange → updateFilters → URL params → fetchPaginatedEvents`.
  The file, its test (134 lines), and its 5-describe test block are legacy residue from when sort was client-side.
- **Concrete change:** Delete both files (`blacklist-table-logic.ts`, `__tests__/blacklist-table-logic.test.ts`). Also remove the lone mention from `docs/agent-code-map.md:211` and `docs/architecture.md:242`. Estimated deletion: ~155 lines + 2 doc lines.
- **Risk:** Very low — `isBlacklistable` is unrelated. Running `npm run lint` after confirms no orphan imports.
- **Priority:** Requires discussion — the code was likely extracted during the structural-simplification effort (see `agents/plans/historical/2026-03-13-*`) to parallel `stablecoin-table-logic.ts`, and keeping it for consistency could be argued. But "match existing style" doesn't mean "keep unused code that only exists to parallel other files." Recommend deletion with a note in the commit message that server-side sort subsumes it.

### H7. `view-model.ts` — `setSearchInput` returned but unused

- **File:** `src/app/blacklist/view-model.ts`
- **Line:** 269 (return), 92 (declaration)
- **Current pain:** `src/app/blacklist/page.tsx` destructures the view-model return but does **not** pull out `setSearchInput`. The actual input control uses `value={searchInput}` + `onChange={(e) => handleSearchChange(e.target.value)}` — `handleSearchChange` already calls `setSearchInput(v)` internally (line 203). Nothing needs the setter to be exported.
- **Concrete change:** Remove `setSearchInput,` from the return object at line 269. The state and `useState` hook stay.
- **Risk:** None — TypeScript confirms no consumer uses it. `npm run build` catches any regression.
- **Priority:** Safe to apply immediately.

### H8. `handleBlacklist` — repeated `instanceof Response` drain pattern

- **File:** `worker/src/api/blacklist.ts`
- **Lines:** 69, 75, 78, 80
- **Current pain:** Four sequential `if (x instanceof Response) return x` checks. Not duplication per se, but the shape is hard to scan; a single fluent extract would be clearer. That said, this is the established pattern across the worker API layer (see `remediate-blacklist-amount-gaps.ts:76`, `blacklist-summary.ts` callers, etc).
- **Concrete change:** None recommended — matches existing style. Flagging so it does not accumulate further.
- **Risk:** N/A.
- **Priority:** **Do NOT change.**

---

## Medium

### M1. `blacklist-contracts.ts` — topic constant naming inconsistency

- **File:** `worker/src/lib/blacklist-contracts.ts`
- **Lines:** 85–97 (USDC/USDT prefixed) vs 389–390 (unprefixed `ADDED_BLACKLIST_TOPIC`, `REMOVED_BLACKLIST_TOPIC`)
- **Current pain:** USDC uses `USDC_BLACKLISTED_TOPIC`, USDT uses `USDT_ADDED_BLACKLIST_TOPIC`, but Hex Trust adds `ADDED_BLACKLIST_TOPIC` (no prefix) and `REMOVED_BLACKLIST_TOPIC`. The unprefixed names read as "the added-blacklist topic" but they're actually only the Hex Trust variant. Anyone grepping for "AddedBlacklist" could easily conflate USDT's `USDT_ADDED_BLACKLIST_TOPIC` with Hex Trust's `ADDED_BLACKLIST_TOPIC`.
- **Concrete change:** Rename to `HEX_TRUST_ADDED_BLACKLIST_TOPIC` / `HEX_TRUST_REMOVED_BLACKLIST_TOPIC` (or `USDX_ADDED_BLACKLIST_TOPIC` since USDX is the only tracked consumer). Trivial find-and-replace within the single file.
- **Risk:** None. Zero cross-file callers for these constants — they're referenced only inside `blacklist-contracts.ts`.
- **Priority:** Safe to apply immediately.

### M2. `blacklist-contracts.ts` — file length and sectioning

- **File:** `worker/src/lib/blacklist-contracts.ts`
- **Lines:** ~645
- **Current pain:** The file mixes four concerns in one module: type definitions (10–57), chain-config bindings (60–80), topic-hash constants and event-family definitions (82–470), and the CONTRACT_CONFIG_SPECS list (506–591) plus lookup helpers (593–644). At ~640 lines it's starting to be awkward to navigate; you have to scroll between family definitions and the specs list when changing anything. **However**, the file is not painful today because:
  - Section comment dividers (`// --- USDC event definitions ---`, etc) are already clear.
  - Everything is related (you usually change events + specs together).
  - Splitting would add import noise and break the rule that "moving files requires updating imports; only recommend if the benefit is clearly worth it."
- **Concrete change:** **None.** A split into `blacklist-event-families.ts` + `blacklist-contract-specs.ts` would save ~1 scroll when navigating, but cost import-graph complexity across 14 existing call sites. Not justified today. Re-evaluate if the file crosses ~1000 lines.
- **Risk:** N/A.
- **Priority:** **Do NOT change.**

### M3. `persistence.ts` — missing `amount` legacy-column comment

- **File:** `worker/src/cron/blacklist/persistence.ts`
- **Lines:** 10–14 (columns list), 20–21 (`row.amount_native, row.amount_native,`)
- **Current pain:** The INSERT lists both `amount` and `amount_native` and binds `row.amount_native` twice. `amount` is a legacy-column holdover — the TypeScript `BlacklistRow` doesn't even declare it — and a new reader will assume this is a copy-paste bug.
- **Concrete change:** Add a single `// amount` column is a legacy duplicate kept in lockstep with amount_native; see methodology v3.2` comment immediately before the INSERT template. Does not change code, just prevents the next maintainer from "fixing" it.
- **Risk:** None.
- **Priority:** Safe to apply immediately.

### M4. `amount-recovery.ts` — `inferErrorClass` is string-matching on error messages

- **File:** `worker/src/cron/blacklist/amount-recovery.ts`
- **Lines:** 70–75
- **Current pain:** The helper does `message.includes("timeout")` / `message.includes("http")` to classify errors. This is fragile — a provider returning `"HTTP 429 throttled timeout"` matches `"timeout"` first and becomes `provider_timeout` instead of `provider_http_error`. The classification is used for telemetry only (not control flow), so it's tolerable, but the ordering is load-bearing and undocumented.
- **Concrete change:** Flip the order so HTTP matches first, or (better) add a one-line comment: `// Order matters: check 'http' before 'timeout' — "HTTP timeout" should classify as http.` The ordering is currently wrong; flip it.
- **Risk:** Low. Telemetry-only, no control flow impact. Worth a quick manual check of historic `amount_last_error_class` distribution to confirm.
- **Priority:** Safe to apply immediately.

### M5. `evm-source.ts` — `addressIndexed` inference is subtle

- **File:** `worker/src/cron/blacklist/evm-source.ts`
- **Lines:** 152–158
- **Current pain:** The statement
  ```ts
  const addressIndexed = forcedDataAddress == null && log.topics.length > topicIdx;
  ```
  means "we infer the address is an indexed topic argument iff no explicit data slot override exists AND a topic at that index exists." This is correct but not obviously so — the variable name "addressIndexed" suggests a boolean property of the event definition when it's actually a derived log-level fact. A reader might conclude it's redundant with `addressTopicIndex`.
- **Concrete change:** Rename to `addressFromTopic` or add a `// inferred per-log: do we have a topic slot for the address?` comment. Ideally both.
- **Risk:** None.
- **Priority:** Safe to apply immediately.

### M6. `blacklist-aggregates.ts` — `computeBlacklistSummaryStats` hard-codes three stablecoin buckets

- **File:** `shared/lib/blacklist-aggregates.ts`
- **Lines:** 43–58
- **Current pain:** The function tracks USDC, USDT, and gold separately (for stats cards), and a global map for `frozenAddresses`. When a new non-USDC/USDT/gold stablecoin is added, `frozenAddresses` picks it up automatically but the three card buckets don't. The code is correct for the public cards (which only show USDC/USDT/Gold), but the pattern `isGold ? goldAddresses : evt.stablecoin === "USDC" ? usdcAddresses : evt.stablecoin === "USDT" ? usdtAddresses : null` is getting hard to read.
- **Concrete change:** Either: (a) rewrite the chain as an explicit `switch (category)` with a `categorizeForStats(symbol)` helper, or (b) don't change — the current shape will stay manageable as long as the card list is frozen at USDC/USDT/Gold, which matches the design.
- **Risk:** None.
- **Priority:** **Do NOT change** unless the design intent changes to show more buckets on the stats cards.

### M7. `blacklist.ts` (shared) — `BLACKLIST_PRICE_ASSET_IDS` vs `isGoldBlacklistStablecoin` drift

- **File:** `shared/lib/blacklist.ts`
- **Lines:** 6–22
- **Current pain:** `isGoldBlacklistStablecoin` is a hand-rolled string-literal check (`"PAXG" || "XAUT"`). `BLACKLIST_PRICE_ASSET_IDS` contains PAXG, XAUT, A7A5, BRZ, EURC, EURI, TGBP — a superset of "gold." The two concepts are separate (gold gets a balance override in `current-balance-cache.ts:185`), but if the gold set ever grows it's easy to miss updating one.
- **Concrete change:** None immediately. If a second gold stablecoin is added, consider replacing with a typed `const GOLD_BLACKLIST_STABLECOINS = ["PAXG", "XAUT"] as const` set and a derived type guard — but avoid premature abstraction.
- **Risk:** N/A.
- **Priority:** **Do NOT change** right now.

### M8. `tron-source.ts` — `parseTronEvent` fallback address key chain

- **File:** `worker/src/cron/blacklist/tron-source.ts`
- **Lines:** 50–55
- **Current pain:** The address extraction falls through `eventDef.tronResultKey || _user || _blackListedUser || "0"`. The fallback is correct for legacy USDT (`_blackListedUser`) and modern events (`_user`), but a reader won't know which contract uses which key without running the parser. A one-line comment explaining why each fallback is needed would help.
- **Concrete change:** Add a `// _user = modern Tether; _blackListedUser = legacy USDT; "0" = positional fallback for unnamed params` comment above the assignment.
- **Risk:** None.
- **Priority:** Safe to apply immediately.

### M9. Tests — `expect(...)` missing for suppression_reason on mirror-zero rows

- **File:** `worker/src/api/__tests__/blacklist-summary.test.ts`
- **Lines:** 33–44 (fixture) + 85 (assertion)
- **Current pain:** The test fixture includes a row with `suppression_reason: "circle_mirror_zero_balance"`, and the test asserts that `totalEvents` is 2 (not 3), proving the row was filtered. Good coverage of the exclusion. But there's no assertion that the post-fetch step **sets** `suppression_reason` for EURC mirror-zero rows during enrichment. The `processFetchedBlacklistRows` function at `post-fetch.ts:104–112` has that logic and is completely untested.
- **Concrete change:** Add a test against `processFetchedBlacklistRows` (or against `enrichRowBalances` directly + a separate assertion on the post-fetch flag) covering the EURC mirror-zero case: blacklist event, `amount_native === 0`, stablecoin === "EURC" → `suppression_reason === "circle_mirror_zero_balance"`.
- **Risk:** Low — test-only.
- **Priority:** Safe to apply immediately (see T3 below).

---

## Low

### L1. `blacklist-table.tsx` — nested ternary in amount cell

- **File:** `src/components/blacklist-table.tsx`
- **Lines:** 171–181
- **Current pain:** The amount cell renders with a 4-branch nested ternary mirroring `amountUsdAtEvent` → native → "N/A"/"—". Same readability concern as H2 but at smaller scale.
- **Concrete change:** Extract `formatBlacklistAmountCell(evt)` returning a `string`. ~15 lines.
- **Risk:** Low. The sibling CSV export at lines 79–85 also has the `amount_native === 0 && event_type !== "destroy"` suppression pattern — consider sharing one formatter across both.
- **Priority:** Safe to apply immediately.

### L2. `view-model.ts` — 300ms debounce is hand-rolled

- **File:** `src/app/blacklist/view-model.ts`
- **Lines:** 201–211
- **Current pain:** The search handler uses `setTimeout`/`clearTimeout` directly. Other Pharos pages appear to do this the same way (`src/app/liquidity/client.tsx:221` uses the setter-as-state pattern), so there's no shared `useDebounce` hook. No action needed — matches existing style.
- **Concrete change:** None.
- **Priority:** **Do NOT change.**

### L3. `blacklist-stats.tsx` — dual-state fallback is legacy compatibility

- **File:** `src/components/blacklist-stats.tsx`
- **Lines:** 15–17
- **Current pain:** The `trackedAddressCount ?? activeAddressCount ?? 0` fallback is a compatibility shim from before tracked fields were added (methodology v3.5). The optional schema in `shared/types/market.ts:533–535` confirms this. Both fields are currently always present in responses, so the fallback is never exercised in production.
- **Concrete change:** Leave as-is. Removing the fallback would require bumping the methodology to tighten the schema (drop `.optional()`) and flushing any cached clients. Not worth the coordination cost.
- **Priority:** **Do NOT change.**

### L4. `blacklist-table.tsx` — hard-coded gold formatting

- **File:** `src/components/blacklist-table.tsx`
- **Lines:** 175–177
- **Current pain:** `isGoldBlacklistStablecoin(evt.stablecoin) ? 4 : 2` hard-codes decimal precision per category. This belongs in a display utility — but `isGoldBlacklistStablecoin` is already in `shared/lib/blacklist.ts` and the formatting call is the only consumer on the frontend, so centralizing it right now would be a single-use abstraction.
- **Concrete change:** None. Matches the "no abstractions for single-use code" rule.
- **Priority:** **Do NOT change.**

### L5. `blacklist-chart.tsx` — `legend` role mismatch

- **File:** `src/components/blacklist-chart.tsx`
- **Lines:** 99–113
- **Current pain:** The legend uses a static `<div>` with visual chips. No `role="list"`. Screen readers will read them as generic text. Other Pharos chart legends have the same shape (`chart-primitives.tsx` companions), so this is a cross-cutting accessibility concern, not a blacklist-specific one.
- **Concrete change:** None for this audit. Log as a follow-up in the cross-page design-system accessibility audit.
- **Priority:** **Do NOT change** as part of the blacklist audit.

### L6. Component loading-state parity

- **Files:** `src/components/blacklist-stats.tsx`, `blacklist-chart.tsx`, `blacklist-table.tsx`, `blacklist-status-charts.tsx`, `blacklist-status-drilldown.tsx`
- **Current pain:** All five components have Skeleton loading states. Good. The only gap: `blacklist-filters.tsx` does not show a loading state while the summary loads (the chain list is empty until `summary.chains` lands). The user sees 4 toggles with just "All" buttons. Minor UX regression.
- **Concrete change:** Add `disabled` or a single skeleton row when `chains.length === 0`. 3 lines.
- **Risk:** None.
- **Priority:** Requires discussion with design — the empty state is intentional on first paint and is briefly visible (<200ms on cached loads), so the fix may not be worth visual noise.

### L7. `error.tsx` — minimal but matches convention

- **File:** `src/app/blacklist/error.tsx`
- **Current pain:** One-liner using `createPageError`. Matches the pattern used elsewhere. No action needed.
- **Priority:** **Do NOT change.**

### L8. `amount-recovery.ts` — `markRecoveryAttempt` optional-parameter default

- **File:** `worker/src/cron/blacklist/amount-recovery.ts`
- **Lines:** 55–68
- **Current pain:** The `nowSec = Math.floor(Date.now() / 1000)` default argument is evaluated at *every* call site, not at function definition — standard JS behavior, but in a tight loop it allocates a fresh `Date.now()` call per row. Not a perf hot path, but if `enrichRowBalances` ever processes 10k rows the millions of `Date.now()` calls add up.
- **Concrete change:** None right now. Batches are capped at 50 rows.
- **Priority:** **Do NOT change.**

### L9. Comments audit — WHAT vs WHY

- **Observations:**
  - `sync-blacklist.ts:114–115`: Good WHY (explains backfill precedence under timeout risk).
  - `sync-blacklist.ts:34–36`: Good WHY (explains safety margin purpose).
  - `current-balance-cache.ts:154–157`: Good WHY (explains preservation across unblacklist).
  - `current-balance-cache.ts:180–187`: Good WHY (gold override reasoning).
  - `blacklist-contracts.ts:88`: Good comment ("legacy: Ethereum, Tron, and pre-USDT0 L2 contracts").
  - `amount-recovery.ts:118–120`: Good WHY (Tron has no historical balance API).
  - `persistence.ts`: **Missing WHY** — the `amount` duplicate column binding (see M3).
  - `parseEvmLogs` amount decoding (evm-source.ts:159–171): **Missing WHY** — the 4-branch fallthrough semantics need a docstring on the decoder helper once extracted (H2).
- **Priority:** Safe to apply as part of the other fixes.

---

## Do NOT Change (rationale-carrying scope fence)

| Concern | Why not |
|---|---|
| Split `blacklist-contracts.ts` into multiple files | Would cost 14 import updates for a minor navigation win. File is well-sectioned today. Re-evaluate above 1000 lines. |
| Extract shared `useDebounce` hook for `view-model.ts` search | No precedent elsewhere in the codebase; single-use; matches the liquidity page's pattern. |
| Consolidate `trackedAddressCount` / `activeAddressCount` fallback in `blacklist-stats.tsx` | Wire-format compatibility. Requires coordinated schema-tightening bump across backend + cached clients. |
| Build an abstraction for the `instanceof Response` guard chain in `handleBlacklist` | It is the established worker API pattern. Fixing just blacklist would fork the style. |
| Introduce a `GOLD_BLACKLIST_STABLECOINS` set | Only two members. Single-use abstraction. |
| Remove `fetchBlacklistAssetPriceFromCache` duplication between `post-fetch.ts:87–89` and `current-balance-cache.ts:146–148` | The double call is intentional: both codepaths need the same price but run in different enrichment phases, and pushing it up a layer is a bigger refactor. |
| Centralize amount-cell formatting logic between `blacklist-table.tsx` and its CSV export | Useful if it ends up in 3 places. Currently 2 — below the threshold. |
| Delete `CompareBlacklistRows` to save ~155 lines (H6) **without** confirming it's truly dead | Already confirmed dead by grep. Safe to delete. Listed in "requires discussion" only because the question of whether parallelism with `stablecoin-table-logic.ts` matters is a style call for the maintainer. |
| Refactor `enrichRowBalances` and `backfillAmounts` into a unified pipeline | The bookkeeping divergence (in-flight mutation vs D1 statements) makes unification cost exceed savings. The H3 extraction of the amount-lookup sub-step is sufficient. |
| Rename `BlacklistRow.amount` in the persistence INSERT | It's a legacy DB column that would require a migration to remove. Comment it instead (M3). |

---

## Test Coverage Gaps (consolidated)

### T1. `parseEvmLogs` — untested decoding paths

**File under test:** `worker/src/cron/blacklist/evm-source.ts`
**Existing tests:** `worker/src/cron/blacklist/__tests__/evm-source.test.ts`

- ✅ `addressTopicIndex: 2` (USD1)
- ✅ default `topicIdx = 1` (USDC)
- ✅ `addressArrayData: true` (USDTB)
- ✅ non-indexed single-address + non-indexed uint256 (A7A5 destroy)
- ✅ `amountTopicIndex: 2` (MNEE)
- ✅ `addressDataIndex: 0` + `amountDataIndex: 1` (BUIDL OmnibusSeize)
- ❌ **indexed address + non-indexed uint256 from data** — the `addressIndexed ? log.data.length >= 66 ? decodeUint256(log.data, …) : null` branch (evm-source.ts:164–167). This is the common USDT0 `DestroyedBlockedFunds(address indexed, uint256)` shape and is the **most-used** decode path for amount-bearing events. A regression here would silently zero amounts for all USDT0 destroys.
- ❌ **non-indexed address + non-indexed uint256 from data.slice(66)** — the final branch (lines 168–170) covering legacy USDT `DestroyedBlackFunds(address, uint256)` when the address is at data[0..66] and amount at data[66..]. Partially exercised by the A7A5 test but that uses `encodeAbiParameters` rather than raw data packing.
- ❌ **blockNumber + timestamp malformed log rejection** — lines 139–141 (`isNaN(blockNumber) || isNaN(timestamp)` guard) is never exercised.
- ❌ **`decodeAddressArrayData` failure path** — the `try/catch` with `console.warn` (lines 76–79) for malformed `address[]` input has no test.
- ❌ **`addressDataIndex` without `amountDataIndex`** — OmnibusSeize tests both together; the single-field path is untested.

**Recommended:** Add 4 more parameterized cases covering these branches.

### T2. `parseTronEvent` — zero tests

**File under test:** `worker/src/cron/blacklist/tron-source.ts`

There is no `tron-source.test.ts` file at all. The fallback chain `eventDef.tronResultKey || _user || _blackListedUser || "0"` is untested, as is the `_balance || _value || "1"` amount chain, the `bigIntToDecimal` conversion for Tron raw strings, and the `TRON_EVENT_NAME_MAP` coverage.

**Recommended:** Add a minimal `tron-source.test.ts` with 3 cases:
1. USDT legacy event with `_blackListedUser` only.
2. USDT modern event with `_user`.
3. USD1 dual-indexed event using `tronResultKey: "account"`.

### T3. EURC mirror-zero suppression

**File under test:** `worker/src/cron/blacklist/post-fetch.ts` lines 104–112

No test confirms that `processFetchedBlacklistRows` **sets** `suppression_reason = "circle_mirror_zero_balance"` on EURC blacklist/unblacklist rows with `amount_native === 0`. The `blacklist-summary.test.ts` asserts the *filtering behavior* downstream, but nothing asserts the *origin* of that flag. A regression where post-fetch.ts stops tagging new EURC rows would be invisible until existing rows churn out.

**Recommended:** Add a direct test against `processFetchedBlacklistRows` (or extract the mirror-zero flagger into a pure function and test it in isolation).

### T4. `resolveBlacklistContractConfig` / `getBlacklistConfigsForSymbolAndChain` — error paths

**File under test:** `worker/src/lib/blacklist-contracts.ts`

- ✅ Resolution happy path (`blacklist-contracts.test.ts:11–32`).
- ❌ `resolveBlacklistStablecoinSymbol` throwing `Error("Unsupported blacklist stablecoin symbol for …")` (lines 480–481) — no test.
- ❌ `chainConfig` throwing `Error("Unknown chain: …")` (lines 62) — no test.
- ❌ `getBlacklistConfigsForSymbolAndChain` returning `[]` (symbol or chain not present) — no test.
- ❌ `getBlacklistConfigsForSymbolAndChain` returning >1 match (ambiguity path feeding `amount-recovery.ts:313–315`) — no test.

**Recommended:** Add 4 small cases.

### T5. `queryBlacklistGapMetrics` — single happy-path test

**File under test:** `worker/src/lib/blacklist-gaps.ts`
**Existing test:** `worker/src/lib/__tests__/blacklist-gaps.test.ts:5–35`

Only one test case with a pre-built mock result. Missing:
- ❌ `totalEvents = 0` (division-by-zero guard check; the guard exists at line 90).
- ❌ Whitelist filter: only `blacklist` and `destroy` event types contribute (line 69). An `unblacklist` row should not show up.
- ❌ `recentWindowSec` parameter override. The default is exercised; the explicit override is not.

**Recommended:** Add 3 short cases.

### T6. `backfillAmounts` — zero tests

**File under test:** `worker/src/cron/blacklist/amount-recovery.ts:253–472`

The in-flight `enrichRowBalances` has a solitary test (`amount-recovery.test.ts`). `backfillAmounts` has **none**. Every failure class declared in the `BlacklistRecoveryErrorClass` union (`config_missing`, `ambiguous_config`, `provider_null`, `provider_timeout`, `provider_http_error`, `provider_unsupported`, `runtime_budget`, `budget_exhausted`) is untested for the DB-pass path. Given that H3 recommends extracting shared code between enrich and backfill, closing this gap is prerequisite work.

**Recommended (priority order):**
1. Config-missing path (row with no `config_key` or `contract_address` and a non-unique `(symbol, chain_id)` match).
2. Ambiguous-config path (multiple matching configs for `(symbol, chain_id)`).
3. Runtime budget hit mid-loop (some rows processed, others deferred).
4. Subrequest budget hit mid-loop.
5. Destroy event + receipt success.
6. Destroy event + receipt miss → historical balance success.
7. Tron blacklist event → immediate `permanently_unavailable` write.

### T7. `enrichRowBalances` — thin coverage

**File under test:** `worker/src/cron/blacklist/amount-recovery.ts:77–181`
**Existing test:** `amount-recovery.test.ts` — single case (A7A5 with price).

- ❌ Destroy + event-receipt success path.
- ❌ Destroy + event-receipt failure → historical balance fallback.
- ❌ `row.amount_status === "permanently_unavailable"` early-return.
- ❌ `event_type` not in `{blacklist, unblacklist, destroy}` skip.
- ❌ Tron blacklist/unblacklist flagged as `permanently_unavailable`.
- ❌ Runtime budget breach marks `amount_last_error_class = "runtime_budget"` and breaks the loop.
- ❌ Subrequest budget breach marks `budget_exhausted`.

**Recommended:** ~6 short cases.

### T8. `fetchDestroyAmountFromLog` — zero unit tests

**File under test:** `worker/src/cron/blacklist/amount-recovery.ts:183–251`

This helper has 5 decoding branches (indexed topic, indexed data-slot, addressIndexed raw data, non-indexed slice, ERC20 Transfer fallback scan). Only the ERC20 Transfer fallback is exercised indirectly via higher-level tests, and even that indirectly. Given that it's the only path to recover PAXG/XAUT `FrozenAddressWiped` amounts (which the contract emits without the destroyed amount), a regression here would silently zero the freeze ledger for those gold tokens.

**Recommended:** Dedicated unit test with mocked `fetchWithRetry`. 5 cases, one per branch.

### T9. `blacklist-contracts.test.ts:69–93` — tests what exists, not what breaks

The "resolves first-wave event families by topic" test (lines 69–93) is a positive-case smoke test. Nothing asserts:
- Unknown topic returns `undefined` from `getBlacklistEventByTopic`.
- Lookup is case-insensitive (the `.toLowerCase()` comparison at line 629).
- Empty/null topic returns `undefined` (the early return at line 628).

**Recommended:** 3 short negative-case tests.

### T10. Frontend — `view-model.test.tsx` is solid

`src/app/blacklist/view-model.test.tsx` covers URL parsing, debounce, scroll-into-view, pagination, and filter updates. No significant gaps. The one missing assertion is that `setSearchInput` is unused (H7 above) — but fixing H7 by removing the export is the correct fix.

---

## Summary Table

| ID | Severity | File | Change | Priority |
|----|----------|------|--------|----------|
| H1 | High | `worker/src/cron/sync-blacklist.ts:218–224, 283–289` | Extract counter-merge helper | Safe |
| H2 | High | `worker/src/cron/blacklist/evm-source.ts:159–171` | Extract `decodeEvmLogAmount` helper | Safe |
| H3 | High | `worker/src/cron/blacklist/amount-recovery.ts:77, 253` | Extract `resolveEvmAmountForRow` helper | Discussion — needs T6/T7 first |
| H4 | High | `worker/src/cron/blacklist/shared.ts:24` | `amount_attempt_count: number \| null` | Safe |
| H5 | High | `worker/src/cron/blacklist/shared.ts:8–12` | Type `event_type`/`amount_source`/`amount_status` as unions | Safe |
| H6 | High | `src/components/blacklist-table-logic.ts` | Delete (dead code) | Discussion |
| H7 | High | `src/app/blacklist/view-model.ts:269` | Remove unused `setSearchInput` from return | Safe |
| M1 | Med | `worker/src/lib/blacklist-contracts.ts:389–390` | Rename `ADDED_BLACKLIST_TOPIC` → `HEX_TRUST_…` | Safe |
| M3 | Med | `worker/src/cron/blacklist/persistence.ts` | Add legacy `amount` column comment | Safe |
| M4 | Med | `worker/src/cron/blacklist/amount-recovery.ts:70–75` | Fix or document `inferErrorClass` ordering | Safe |
| M5 | Med | `worker/src/cron/blacklist/evm-source.ts:157` | Rename `addressIndexed` → `addressFromTopic` | Safe |
| M8 | Med | `worker/src/cron/blacklist/tron-source.ts:50–55` | Add fallback-key WHY comment | Safe |
| M9 | Med | `worker/src/cron/blacklist/post-fetch.ts:104–112` | Test mirror-zero suppression | Safe |
| L1 | Low | `src/components/blacklist-table.tsx:171–181` | Extract `formatBlacklistAmountCell` | Safe |
| L6 | Low | `src/components/blacklist-filters.tsx` | Add loading state | Discussion |
| T1–T10 | — | Various | Fill test gaps above | Safe |
