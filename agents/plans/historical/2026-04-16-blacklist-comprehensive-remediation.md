# Blacklist Comprehensive Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute every finding from the 2026-04-16 blacklist audit (Agents A, B, C, D) to restore data accuracy, unblock silently-failing ingestion, expand coverage, attribute amounts to previously-unattributed events, and modernise the code.

**Architecture:** The remediation is split into 8 phases. Phase 1–3 stop ongoing data corruption. Phase 4 expands coverage. Phase 5 is the amount-attribution program that converts ~11,500 currently-unattributed rows into resolved or properly-provenanced amounts. Phase 6–7 clean up code and tests. Phase 8 ships polish + research for future non-EVM work. Within each phase, tasks that touch disjoint files are marked `parallel-safe: yes` and can be dispatched to independent Opus subagents.

**Tech Stack:**
- Worker: TypeScript, Cloudflare Workers, D1 (database `stablecoin-db`, binding `DB`, id `8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`)
- Shared: runtime-neutral TypeScript (`shared/lib/*`, `shared/types/*`)
- Frontend: Next.js 16 static export, React, TanStack Query
- Testing: Vitest (`npm test`), worker tsc (`cd worker && npx tsc --noEmit`), lint (`npm run lint`)
- Pre-push gate: `npm run test:merge-gate`

---

## Source Documents

- `agents/audits/2026-04-16-blacklist-agent-a-data-accuracy.md` — Agent A findings
- `agents/audits/2026-04-16-blacklist-agent-b-coverage-gaps.md` — Agent B findings
- `agents/audits/2026-04-16-blacklist-agent-c-code-quality.md` — Agent C findings
- `agents/audits/2026-04-16-blacklist-agent-d-amount-attribution.md` — Agent D findings

---

## Pre-Computed Values

These values are computed once here so no task has to re-derive them.

### Keccak256 topic hashes for new events

| Signature | Topic hash |
|---|---|
| `FrozenAccountDrained(address,address,uint256)` | `0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef` |
| `FrozenFundsReallocated(address,address,address,uint256)` | `0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a` |
| `Blacklisted(address,bool)` | `0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8` |

Every hash-verifying task must re-run the `keccak256` check before committing:
```bash
node -e 'const{keccak256,toBytes}=require("viem");console.log(keccak256(toBytes("FrozenAccountDrained(address,address,uint256)")));'
```

### Production database access

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "<SQL>"
```

The database binding in `worker/wrangler.toml` is `DB` and the physical name is `stablecoin-db`.

### Corrected Arbitrum start blocks (verified via Blockscout creation-tx lookups)

| Config | Current `startBlock` | Corrected `startBlock` | Gap |
|---|---:|---:|---|
| FDUSD Arbitrum (`0x…9fe`) | `452_845_221` | `336_278_229` | ~117M blocks / ~11 months |
| AUSD Arbitrum (`0x…012a`) | `431_248_926` | `342_153_906` | ~89M blocks / ~8.5 months |
| BUIDL Arbitrum (`0x…5872`) | `452_787_226` | `270_969_308` | ~181M blocks / ~17.5 months |

---

## Parallelization Map

Tasks within a phase that touch disjoint files can run in parallel. Tasks that share a primary file must serialize. Phase gates: all tasks in a phase must complete before the next phase starts (unless explicitly noted).

```
Phase 1 — Urgent data integrity      [parallel-safe within phase]
  1.1 methodology tiebreak            (shared/lib/methodology-version.ts)
  1.2 BUIDL Seize amountDataIndex     (worker/src/lib/blacklist-contracts.ts)
  1.3 diagnostic error logging        (worker/src/cron/sync-blacklist.ts)
  1.4 EURC suppression hardening      (worker/src/cron/blacklist/post-fetch.ts + amount-recovery.ts)
  1.5 docs stablecoin param list      (docs/blacklist-tracker.md)

Phase 2 — A-H3 root cause             [serial: depends on 1.3]
  2.1 inspect cron_runs metadata      (read-only wrangler queries)
  2.2 root-cause fix                  (file depends on diagnosis)
  2.3 retro-replay historic coverage  (wrangler admin endpoint)

Phase 3 — Arbitrum startBlock repair  [serial]
  3.1 correct 3 startBlock values     (worker/src/lib/blacklist-contracts.ts)
  3.2 hard-reset 3 sync-state rows    (wrangler)
  3.3 verify first re-scan cycle      (wrangler)

Phase 4 — Coverage expansion          [serial: all touch blacklist-contracts.ts]
  4.1 wlfi-freeze destroy extension   (USD1/U/FDUSD/EURI)
  4.2 USDC on 5 new chains            (Linea, Sonic, Unichain, Worldchain, Celo)
  4.3 USDT0 on 11 new chains          (Ink, Berachain, Mantle, Sei, HyperEVM, Unichain, Monad, Flare, Plasma, XLayer, Corn)
  4.4 USDP Paxos coverage             (Ethereum)
  4.5 EURC Worldchain                 (pending FiatTokenV2 verification)
  4.6 TUSD with bool-param decoder    (Ethereum) [new event family + shared decoder change]
  4.7 methodology version bump        (shared/lib/blacklist-tracker-version.ts + docs)

Phase 5 — Amount attribution          [mixed parallelism]
  5.1 add current_balance_snapshot to amount_source union   [parallel-safe after 5.0]
  5.2 Tron ledger-join backfill function (amount-recovery.ts)
  5.3 stop stamping Tron permanently_unavailable at ingest  (tron-source.ts) [parallel-safe]
  5.4 widen backfillAmounts WHERE clause for legacy derived zero
  5.5 frontend provenance badge        (blacklist-table.tsx) [parallel-safe after 5.1]
  5.6 methodology doc update for attribution changes

Phase 6 — Code quality                [parallel-safe across lanes]
  Lane A: 6.1 BlacklistRow type drift  (shared.ts) — must run before other lanes
  Lane B: 6.2 decodeEvmLogAmount helper (evm-source.ts)
  Lane C: 6.4 topic-constant rename     (blacklist-contracts.ts)
  Lane C: 6.5 persistence legacy-column comment (persistence.ts)
  Lane C: 6.6 inferErrorClass ordering + comment (amount-recovery.ts)
  Lane C: 6.7 addressFromTopic rename + comment (evm-source.ts)
  Lane C: 6.8 tronResultKey comment (tron-source.ts)
  Lane D: 6.9 delete blacklist-table-logic.ts + test
  Lane D: 6.10 remove unused setSearchInput (view-model.ts)
  Lane D: 6.11 extract formatBlacklistAmountCell (blacklist-table.tsx)
  (NOTE: Agent C finding H1 "counter merge duplication" was already
   resolved in worker/src/cron/blacklist/post-fetch-counters.ts before
   this audit — Task 6.3 has been removed from this plan.)

Phase 7 — Test coverage               [parallel-safe, new files only]
  7.1 parseTronEvent tests              (new tron-source.test.ts)
  7.2 backfillAmounts tests             (extend amount-recovery.test.ts)
  7.3 fetchDestroyAmountFromLog tests   (extend amount-recovery.test.ts or new file)
  7.4 parseEvmLogs missing branches     (extend evm-source.test.ts)
  7.5 EURC mirror-zero flagging test    (extend post-fetch.test.ts or new)
  7.6 blacklist-contracts error paths   (extend blacklist-contracts.test.ts)

Phase 8 — Polish + research           [parallel-safe]
  8.1 DecentralisedNoFreezeCard UI      (new component)
  8.2 Non-EVM schema design doc         (agents/research/)
  8.3 filters loading state             (blacklist-filters.tsx)
```

---

## Commit Batching Plan

Each commit should run `npm run test:merge-gate` before pushing. Group by theme:

| Commit | Phase | Message (conventional-commits) |
|---|---|---|
| C1 | 1.1 | `blacklist: fix methodology version tiebreak (v3.9 was shadowed by v3.8)` |
| C2 | 1.2 | `blacklist: fix BUIDL Seize amount decoding (latent)` |
| C3 | 1.3 | `blacklist: log err.message in sync-blacklist apiErrorConfigs` |
| C4 | 1.4 | `blacklist: harden EURC mirror-zero suppression across backfill path` |
| C5 | 1.5 | `docs: list all 23 stablecoins in blacklist API params` |
| C6 | 2.x | `blacklist: fix <root-cause> triggering exception:Error on 8 configs` (concrete wording after diagnosis) |
| C7 | 3.x | `blacklist: correct Arbitrum startBlocks for FDUSD/AUSD/BUIDL` |
| C8 | 4.1 | `blacklist: extend wlfi-freeze with FrozenAccountDrained + FrozenFundsReallocated` |
| C9 | 4.2 | `blacklist: add USDC coverage on Linea/Sonic/Unichain/Worldchain/Celo` |
| C10 | 4.3 | `blacklist: add USDT0 Token coverage on 11 LayerZero chains` |
| C11 | 4.4 | `blacklist: add USDP Paxos coverage on Ethereum` |
| C12 | 4.5 | `blacklist: add EURC Worldchain coverage` |
| C13 | 4.6 | `blacklist: add TUSD coverage with bool-param event decoder` |
| C14 | 4.7 | `blacklist: bump tracker methodology to v3.91 for coverage wave + corrections` |
| C15 | 5.1–5.3 | `blacklist: introduce current_balance_snapshot amount source and Tron ledger mirror` |
| C16 | 5.4 | `blacklist: recover legacy derived-zero rows in backfillAmounts` |
| C17 | 5.5 | `blacklist: provenance badge for snapshot-sourced amounts on table` |
| C18 | 5.6 | `docs: document amount provenance tiers in blacklist methodology` |
| C19 | 6.1 | `blacklist: type BlacklistRow with precise unions (event_type/amount_source/amount_status)` |
| C20 | 6.2 | `blacklist: extract decodeEvmLogAmount helper` |
| C21 | 6.4–6.8 | `blacklist: naming and comment cleanups across cron and contracts` |
| C22 | 6.9–6.11 | `blacklist: remove dead client-sort code and tidy frontend view-model` |
| C23 | 7.x | `blacklist: fill test coverage gaps (Tron, backfill, destroy recovery, EVM parse branches)` |
| C24 | 8.1 | `blacklist: add DecentralisedNoFreezeCard transparency UI` |
| C25 | 8.2 | `docs: non-EVM blacklist schema design draft (Solana/Stellar/XRPL)` |
| C26 | 8.3 | `blacklist: show loading state on filter dropdowns` |

Every commit must end with:
```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Phase 1 — Urgent Data Integrity

> **Phase goal:** stop the 5 ongoing correctness bugs. All 5 tasks touch disjoint files and are **parallel-safe**. Run them in a single parallel batch. Gate: `npm test && cd worker && npx tsc --noEmit && npm run lint` all green.

### Task 1.1: Fix methodology version tiebreak

**Files:**
- Modify: `shared/lib/methodology-version.ts:68-71` (windows sort)
- Test: `shared/lib/__tests__/methodology-version.test.ts` (may not yet exist)

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C1

- [ ] **Step 1: Find or create the methodology-version test file**

```bash
ls shared/lib/__tests__/methodology-version.test.ts 2>/dev/null || echo "missing"
```

If the file exists, read it. If missing, create it with the failing-test content in Step 2.

- [ ] **Step 2: Write the failing test**

Add to `shared/lib/__tests__/methodology-version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMethodologyVersion } from "../methodology-version";

describe("createMethodologyVersion", () => {
  it("resolves to the higher version when two entries share effectiveAt", () => {
    // Regression guard: v3.9 and v3.8 shared effectiveAt=1776211200 and the
    // loop was silently resolving to 3.8. The sort tiebreak must prefer the
    // higher version so the loop assigns it last.
    const methodology = createMethodologyVersion({
      currentVersion: "3.9",
      changelogPath: "/foo",
      changelog: [
        { version: "3.9", title: "", date: "", effectiveAt: 1000, summary: "", impact: [], commits: [], reconstructed: false },
        { version: "3.8", title: "", date: "", effectiveAt: 1000, summary: "", impact: [], commits: [], reconstructed: false },
        { version: "3.7", title: "", date: "", effectiveAt: 900, summary: "", impact: [], commits: [], reconstructed: false },
      ],
    });
    expect(methodology.getVersionAt(1000)).toBe("3.9");
    expect(methodology.getVersionAt(999)).toBe("3.7");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run shared/lib/__tests__/methodology-version.test.ts
```

Expected: FAIL — `getVersionAt(1000)` returns `"3.8"`, not `"3.9"`.

- [ ] **Step 4: Implement the fix**

Edit `shared/lib/methodology-version.ts`, replacing the `windows` construction (current lines 68–70):

```ts
  const windows: VersionWindow[] = sortedChangelog
    .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
    .sort((a, b) => {
      const timeDiff = a.effectiveAt - b.effectiveAt;
      if (timeDiff !== 0) return timeDiff;
      // Stable-sort tiebreak: when two entries share effectiveAt, place the
      // LOWER version first so the getVersionAt loop assigns the higher
      // version last (and wins). Without this, a stable sort preserves
      // descending-version input order and the lower version wins.
      return compareMethodologyVersions(a.version, b.version);
    });
```

- [ ] **Step 5: Run tests to verify fix**

```bash
npx vitest run shared/lib/__tests__/methodology-version.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all methodology consumers**

```bash
npx vitest run shared/lib/__tests__
```

Expected: every existing methodology-version-related test still passes (6 methodologies use this helper).

- [ ] **Step 7: Verify the type-check still passes**

```bash
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add shared/lib/methodology-version.ts shared/lib/__tests__/methodology-version.test.ts
git commit -m "$(cat <<'EOF'
blacklist: fix methodology version tiebreak (v3.9 was shadowed by v3.8)

Two changelog entries sharing the same effectiveAt timestamp were resolved
in input order by the stable sort, so the loop in getVersionAt overwrote
the higher version with the lower one. Add an explicit tiebreak that
places the lower version first, so the higher version is assigned last.

All events ingested on or after 2026-04-15 will be re-tagged v3.9 on
subsequent writes. The methodology envelope of existing rows remains v3.8
until they are re-enriched.

Fixes Agent A finding H1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: Fix BUIDL `Seize` amount decoding

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — `SECURITIZE_SEIZE_EVENT_FAMILY` `Seize` entry
- Test: `worker/src/cron/blacklist/__tests__/evm-source.test.ts` — add Seize case

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C2

Background: `Seize(address indexed from, address indexed to, uint256 value, string reason)` has both addresses indexed. `parseEvmLogs` takes the `addressIndexed` branch and decodes `log.data` as a single uint256, which parses the entire `(value + offset + length + reason_bytes)` blob. OmnibusSeize already has `addressDataIndex: 0, amountDataIndex: 1`; Seize needs `amountDataIndex: 0`.

- [ ] **Step 1: Add failing test for Seize decoding**

Append to `worker/src/cron/blacklist/__tests__/evm-source.test.ts` (inside the existing `describe("parseEvmLogs", ...)` block):

```ts
  it("decodes BUIDL Seize with amountDataIndex=0 (regression for Agent A C1)", async () => {
    const { encodeAbiParameters, keccak256, toBytes } = await import("viem");
    const seizeTopic = keccak256(toBytes("Seize(address,address,uint256,string)"));
    // data layout: [uint256 value, string reason] — ABI-encoded
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "string" }],
      [25_000_000n, "test"],
    );
    const fromAddress = "0x000000000000000000000000" + "a".repeat(40);
    const toAddress = "0x000000000000000000000000" + "b".repeat(40);
    const config = findConfig("buidl-blackrock", "ethereum");
    const rows = parseEvmLogs(config, [
      {
        address: config.contractAddress,
        topics: [seizeTopic, fromAddress, toAddress],
        data,
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_native).toBe(25);
    expect(rows[0].event_type).toBe("destroy");
  });
```

Note: `findConfig` is whatever helper already used elsewhere in this file. If the file does not have one, inline an expression like `CONTRACT_CONFIGS.find((c) => c.stablecoinId === "buidl-blackrock" && c.chain.chainId === "ethereum")!`.

- [ ] **Step 2: Run the new test and confirm it fails**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts -t "BUIDL Seize"
```

Expected: FAIL. The asserted `amount_native === 25` should be wildly wrong (some astronomical BigInt from decoding the whole data blob).

- [ ] **Step 3: Apply the fix**

Edit `worker/src/lib/blacklist-contracts.ts` inside `SECURITIZE_SEIZE_EVENT_FAMILY`. Change the `Seize` entry to add `addressTopicIndex: 1, amountDataIndex: 0`:

```ts
const SECURITIZE_SEIZE_EVENT_FAMILY = defineEventFamily("securitize-seize", [
  {
    signature: "Seize(address,address,uint256,string)",
    topicHash: SECURITIZE_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 1, // from (victim)
    amountDataIndex: 0,   // value occupies the first 32-byte data slot (reason follows as dynamic tail)
  },
  {
    signature: "OmnibusSeize(address,address,uint256,string,uint8)",
    topicHash: SECURITIZE_OMNIBUS_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressDataIndex: 0,
    amountDataIndex: 1,
  },
]);
```

- [ ] **Step 4: Re-run the test and confirm it passes**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts -t "BUIDL Seize"
```

Expected: PASS.

- [ ] **Step 5: Run the full evm-source test suite**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
```

Expected: all pass, including existing OmnibusSeize and USDC/USDT/USDtb cases.

- [ ] **Step 6: Type-check worker**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts
git commit -m "$(cat <<'EOM'
blacklist: fix BUIDL Seize amount decoding (latent)

The Securitize Seize event has both address params indexed, so parseEvmLogs
was falling through to decodeUint256(log.data, decimals) on the full data
blob (value + reasonOffset + reasonLength + reason_bytes). This would have
produced a wildly inflated amount_native for the first real Seize.
OmnibusSeize was already safe via its explicit amountDataIndex: 1.

Declare addressTopicIndex: 1 + amountDataIndex: 0 so the parser reads the
victim from topics[1] and the seized value from the first data slot.

Fixes Agent A finding C1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 1.3: Instrument `exception:Error` with real error messages

**Files:**
- Modify: `worker/src/cron/sync-blacklist.ts` — `recordApiErrorConfig` + outer catch
- Test: `worker/src/cron/__tests__/sync-blacklist.test.ts` — extend existing error-metadata test

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C3

Background: Agent A found 8 configs with `exception:Error` in `apiErrorConfigs` but cannot diagnose them because the outer catch records `err.name` only. Add message + short stack.

- [ ] **Step 1: Read the current catch block**

```bash
sed -n '350,365p' worker/src/cron/sync-blacklist.ts
```

Record the exact current text so the Edit tool can match it. Use the Read tool if sed output is hard to parse — the outer catch starts around line 352.

- [ ] **Step 2: Extend the apiErrorConfigs shape**

Change the type declaration near the top of `syncBlacklist`:

```ts
  const apiErrorConfigs: Array<{
    configKey: string;
    stablecoin: string;
    chainId: string;
    reason: string;
    errorMessage?: string;
    stackHead?: string;
  }> = [];
```

And the helper:

```ts
  const recordApiErrorConfig = (
    configKey: string,
    stablecoin: string,
    chainId: string,
    reason: string,
    error?: unknown,
  ): void => {
    if (apiErrorConfigs.length >= 10) return;
    const entry: {
      configKey: string;
      stablecoin: string;
      chainId: string;
      reason: string;
      errorMessage?: string;
      stackHead?: string;
    } = { configKey, stablecoin, chainId, reason };
    if (error instanceof Error) {
      entry.errorMessage = error.message.slice(0, 200);
      if (error.stack) {
        entry.stackHead = error.stack.split("\n").slice(0, 3).join(" | ").slice(0, 240);
      }
    }
    apiErrorConfigs.push(entry);
  };
```

- [ ] **Step 3: Update the outer catch to pass `err` through**

Replace the outer catch body:

```ts
    } catch (err) {
      apiErrors++;
      const errorClass = err instanceof Error ? err.name : "UnknownError";
      apiErrorClasses[errorClass] = (apiErrorClasses[errorClass] ?? 0) + 1;
      recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, `exception:${errorClass}`, err);
      console.warn(`[sync-blacklist] Failed ${config.stablecoin} on ${config.chain.chainName}:`, err);
    }
```

Also update the pre-existing `recordApiErrorConfig` call inside the EVM `apiError` branch (search for `recordApiErrorConfig(configKey, config.stablecoin, config.chain.chainId, partialAdvance`) — that call has no error object and should pass `undefined` explicitly so the signature is consistent.

- [ ] **Step 4: Run existing test**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-blacklist.test.ts
```

Expected: PASS (the new fields are optional so existing assertions still hold).

- [ ] **Step 5: Add targeted assertion for the new fields**

Find the existing test that exercises `apiErrorConfigs`. If there is one that injects a thrown error (`throw new Error("boom")`), add an assertion:

```ts
    expect(metadata.apiErrorConfigs?.[0]?.errorMessage).toContain("boom");
```

If no test throws today, add a new test that wraps one of the mocked provider calls in a `vi.fn().mockRejectedValueOnce(new Error("synthetic boom"))` and asserts that `metadata.apiErrorConfigs[0]` includes both `errorMessage` containing `"synthetic boom"` and a non-empty `stackHead`.

- [ ] **Step 6: Run the extended test**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-blacklist.test.ts
```

Expected: PASS.

- [ ] **Step 7: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/sync-blacklist.ts worker/src/cron/__tests__/sync-blacklist.test.ts
git commit -m "$(cat <<'EOM'
blacklist: log err.message in sync-blacklist apiErrorConfigs

Top-level catch was only capturing err.name ("Error"), which hid the
actual failure mode for USDG/RLUSD/USDO/EURC/EURI/USDC configs that
throw on every cron run. Record err.message plus the first 3 stack
lines so the next run surfaces the root cause in cron_runs metadata.

Refs Agent A finding H3 (diagnostic patch; root-cause fix follows).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 1.4: Harden EURC mirror-zero suppression across the backfill path

**Files:**
- Modify: `worker/src/cron/blacklist/post-fetch.ts` — extract `shouldSuppressAsMirrorZero` helper
- Modify: `worker/src/cron/blacklist/amount-recovery.ts` — apply helper before any `UPDATE` that sets `amount_native = 0`
- Test: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts` — add regression

**Parallel-safe:** partial — touches `amount-recovery.ts` which other later tasks also touch, but this task modifies different SQL branches so it is still independent within Phase 1.
**Blocked by:** none
**Commit:** C4

- [ ] **Step 1: Read the current suppression logic**

```bash
sed -n '100,115p' worker/src/cron/blacklist/post-fetch.ts
```

- [ ] **Step 2: Extract the suppression helper**

Add to `worker/src/cron/blacklist/post-fetch.ts` (near the top, above `filterNewBlacklistRows`):

```ts
export function shouldSuppressAsMirrorZero(
  stablecoin: string,
  eventType: string,
  amountNative: number | null,
): boolean {
  // Circle often mirrors a USDC blacklist action on EURC with no actual
  // EURC balance at the victim address. Those rows are kept auditable in
  // storage but excluded from public aggregates. Suppression must apply
  // equally to ingestion and backfill-path writes; otherwise a
  // transiently-failed enrichment can later resolve to 0 and leak into
  // /api/blacklist.
  return (
    stablecoin === "EURC"
    && (eventType === "blacklist" || eventType === "unblacklist")
    && amountNative === 0
  );
}
```

- [ ] **Step 3: Use the helper from the in-flight path**

Replace the existing loop in `processFetchedBlacklistRows`:

```ts
  for (const row of newRows) {
    if (shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native)) {
      row.suppression_reason = "circle_mirror_zero_balance";
    }
  }
```

- [ ] **Step 4: Use the helper from the backfill path**

In `worker/src/cron/blacklist/amount-recovery.ts backfillAmounts`, find the block that runs the successful-amount `UPDATE blacklist_events SET amount = ?, amount_native = ?, ...`. Wrap the `amount != null` success branch so that when `shouldSuppressAsMirrorZero` returns `true`, the SQL also sets `suppression_reason = 'circle_mirror_zero_balance'`:

```ts
    if (amount != null) {
      const shouldSuppress = shouldSuppressAsMirrorZero(config.stablecoin, row.event_type, amount);
      stmts.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount = ?,
               amount_native = ?,
               amount_usd_at_event = ?,
               amount_source = ?,
               amount_status = ?,
               suppression_reason = COALESCE(suppression_reason, ?),
               contract_address = COALESCE(contract_address, ?),
               config_key = COALESCE(config_key, ?),
               amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?
           WHERE id = ?`,
        ).bind(
          amount,
          amount,
          computeBlacklistAmountUsdAtEvent(config.stablecoin, amount, assetPriceUsd),
          amountSource,
          amountStatus,
          shouldSuppress ? "circle_mirror_zero_balance" : null,
          config.contractAddress,
          config.configKey,
          attemptAt,
          lastErrorClass,
          lastProvider,
          row.id,
        ),
      );
    }
```

Add the import at the top of `amount-recovery.ts`:

```ts
import { shouldSuppressAsMirrorZero } from "./post-fetch";
```

- [ ] **Step 5: Write failing regression tests**

Add to `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts`:

```ts
  describe("EURC mirror-zero suppression (regression)", () => {
    it("suppresses a fresh EURC blacklist row when enrichment returns 0", () => {
      // Unit-test the pure helper since hitting the full backfill path is
      // already covered elsewhere.
      expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 0)).toBe(true);
      expect(shouldSuppressAsMirrorZero("EURC", "unblacklist", 0)).toBe(true);
    });

    it("leaves EURC destroy rows unsuppressed even at zero", () => {
      expect(shouldSuppressAsMirrorZero("EURC", "destroy", 0)).toBe(false);
    });

    it("leaves non-EURC rows unsuppressed at zero", () => {
      expect(shouldSuppressAsMirrorZero("USDC", "blacklist", 0)).toBe(false);
    });

    it("ignores non-zero amounts", () => {
      expect(shouldSuppressAsMirrorZero("EURC", "blacklist", 123)).toBe(false);
      expect(shouldSuppressAsMirrorZero("EURC", "blacklist", null)).toBe(false);
    });
  });
```

Add the import:

```ts
import { shouldSuppressAsMirrorZero } from "../post-fetch";
```

- [ ] **Step 6: Run the new tests**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the broader post-fetch and blacklist test set**

```bash
cd worker && npx vitest run src/cron/blacklist
```

Expected: all green. Particular attention to any existing test that asserts `suppression_reason === null` for a specific row type — if one flakes, it's because we correctly flipped a previously-leaking case.

- [ ] **Step 8: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/blacklist/post-fetch.ts worker/src/cron/blacklist/amount-recovery.ts worker/src/cron/blacklist/__tests__/amount-recovery.test.ts
git commit -m "$(cat <<'EOM'
blacklist: harden EURC mirror-zero suppression across backfill path

Suppression was only applied at ingestion, so a transiently-failed
enrichment could later resolve to 0 in backfillAmounts and leave
suppression_reason NULL — leaking into /api/blacklist. Extract
shouldSuppressAsMirrorZero to a shared helper and apply it in both the
in-flight and backfill UPDATE paths.

Fixes Agent A findings M1/M2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 1.5: Update API param docs to list all 23 stablecoins

**Files:**
- Modify: `docs/blacklist-tracker.md:649` (the stablecoin param row of the API params table)

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C5

- [ ] **Step 1: Read the table row**

```bash
sed -n '645,660p' docs/blacklist-tracker.md
```

- [ ] **Step 2: Edit the row to list all 23 symbols**

Replace the `stablecoin` row with:

```md
| `stablecoin` | string | --      | Filter by name (`"USDC"`, `"USDT"`, `"PAXG"`, `"XAUT"`, `"PYUSD"`, `"USD1"`, `"USDG"`, `"RLUSD"`, `"U"`, `"USDTB"`, `"A7A5"`, `"FDUSD"`, `"BRZ"`, `"AUSD"`, `"MNEE"`, `"EURI"`, `"USDQ"`, `"USDO"`, `"USDX"`, `"AID"`, `"TGBP"`, `"EURC"`, `"BUIDL"`) |
```

- [ ] **Step 3: Verify counts match code**

```bash
grep -c '"' shared/types/market.ts | head -1
```

Then grep for the enum array:

```bash
grep -A 30 "BLACKLIST_STABLECOINS" shared/types/market.ts | head -35
```

Count the entries and confirm the docs row mentions all 23.

- [ ] **Step 4: Commit**

```bash
git add docs/blacklist-tracker.md
git commit -m "$(cat <<'EOM'
docs: list all 23 stablecoins in blacklist API params

The param table only showed the first-wave 11 symbols while the next
line correctly enumerated all 23. Bring the param row up to date so
third-party consumers can discover the wave-2a filters.

Fixes Agent A finding H5.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 1 completion gate:**

```bash
npm run test:merge-gate
```

Expected: all green. If the gate fails on something unrelated, fix the underlying problem or (if the failure is outside blacklist scope) open a sibling PR — do not `--no-verify`.

---

## Phase 2 — Root Cause `exception:Error` on 8 Configs

> **Phase goal:** Diagnose the silent failures surfaced by Task 1.3's diagnostic patch, fix the root cause, and retro-replay the historic coverage for USDG/RLUSD/USDO/EURC (Ethereum)/EURC (Base)/EURI (BSC)/USDC (Arbitrum)/USDC (Base). This phase is SERIAL — each task depends on the previous one's evidence.

### Task 2.1: Inspect current cron_runs metadata for failing configs

**Files:** read-only — no file changes

**Parallel-safe:** no
**Blocked by:** Task 1.3 deployed to production (either via merge-and-deploy or via local wrangler `--remote` inspection of already-enriched metadata if the next cron has run)
**Commit:** none (investigation only; findings recorded in task 2.2)

- [ ] **Step 1: Pull the latest sync-blacklist runs**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "SELECT started_at, metadata FROM cron_runs WHERE job_name = 'sync-blacklist' ORDER BY started_at DESC LIMIT 3;" --json > /tmp/cron_runs.json
cat /tmp/cron_runs.json | python3 -c 'import json,sys; data=json.load(sys.stdin); rows=data[0]["results"]; [print(json.dumps(json.loads(r["metadata"]).get("apiErrorConfigs",[]), indent=2)) for r in rows]'
```

- [ ] **Step 2: Extract distinct error messages per configKey**

Record the exact `errorMessage` and `stackHead` values for each of the 8 known failing configs:
- `ethereum-0xe343167631d89b6ffc58b88d6b7fb0228795491d` (USDG)
- `ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed` (RLUSD)
- `ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe` (USDO)
- `ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` (EURC)
- `base-0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42` (EURC Base)
- `bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7` (EURI BSC)
- `arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831` (USDC Arbitrum)
- `base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (USDC Base)

- [ ] **Step 3: Classify the failures**

Group by root cause. Candidates:
- `BigInt` parse failures on malformed `log.data` (would throw `SyntaxError: Cannot convert 0x… to a BigInt`)
- `decodeAbiParameters` throws on a misshapen `address[]` payload
- `fetchEvmEventsIncremental` propagates an unhandled rejection from `fetchEtherscanProxyHex` / `fetchAlchemyLogs`
- D1 write failure (e.g., `UNIQUE constraint failed`)
- `resolveRequiredTrackedContractConfig` throwing after a JSON refresh
- Abort-signal leak

Write findings into a new file at `agents/research/2026-04-16-blacklist-ah3-diagnosis.md` (one section per configKey, with the errorMessage + stackHead + your hypothesis + proposed fix).

- [ ] **Step 4: Commit the research note**

```bash
git add agents/research/2026-04-16-blacklist-ah3-diagnosis.md
git commit -m "$(cat <<'EOM'
blacklist: record Agent A H3 root-cause diagnosis

Capture the exact error messages and stack heads from cron_runs for
the 8 configs throwing exception:Error on every sync-blacklist cycle,
with a classification and proposed fix per configKey. Used by Task 2.2.

Refs Agent A finding H3.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 2.2: Root-cause fix(es)

**Files:** depends on diagnosis from 2.1. Typical candidates:
- `worker/src/cron/blacklist/evm-source.ts` — parser resilience
- `worker/src/cron/blacklist/tron-source.ts` — parser resilience
- `worker/src/lib/evm-logs.ts` — decoder resilience
- `worker/src/cron/blacklist/post-fetch.ts` — insertion error handling
- `worker/src/cron/sync-blacklist.ts` — per-config try/catch narrowing
- `worker/src/cron/blacklist/__tests__/*.test.ts` — regression test per root cause
- `worker/src/lib/blacklist-contracts.ts` — if a config-level fix (e.g., a topic hash was wrong for one contract)

**Parallel-safe:** no
**Blocked by:** Task 2.1 findings recorded
**Commit:** C6 (single commit if all 8 configs share one root cause; up to 3 commits if there are distinct root causes per config family)

- [ ] **Step 1: For each distinct root cause identified in 2.1, write a failing test**

The test must exercise the exact failure mode (e.g., a specific malformed log layout, a specific RPC response shape, a specific write-time collision). Use a `vi.mocked()` fixture that reproduces what the live cron saw. If the bug is a `BigInt` parse failure on a known contract log, capture the actual log data with:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "SELECT tx_hash, event_topic0, event_signature FROM blacklist_events WHERE contract_address = '0xe343167631d89b6ffc58b88d6b7fb0228795491d' LIMIT 5;"
```

If no rows exist yet (USDG has zero ingested rows), pull a real log from Blockscout via WebFetch or curl:

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=0xe343167631d89b6ffc58b88d6b7fb0228795491d&topic0=0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392&fromBlock=20915336&toBlock=20915336" | head -c 2000
```

- [ ] **Step 2: Run the failing test**

```bash
cd worker && npx vitest run <path-to-new-test>
```

Expected: FAIL reproducing the exact error.

- [ ] **Step 3: Apply the fix**

- If parser resilience: narrow the try/catch so a single malformed log does not poison the whole contract's batch. Use a `try { buildBlacklistRow(...) } catch (err) { console.warn(`[blacklist] skipping malformed ${config.configKey} log`, err); continue; }` pattern.
- If the fix is a proper correction (wrong topic hash, wrong `startBlock`, wrong `addressDataIndex`), update `blacklist-contracts.ts` and cite the evidence in the commit message.

- [ ] **Step 4: Verify the failing test now passes**

```bash
cd worker && npx vitest run <path-to-new-test>
```

Expected: PASS.

- [ ] **Step 5: Run the full blacklist test suite**

```bash
cd worker && npx vitest run src/cron/blacklist src/cron/__tests__ src/lib/__tests__/blacklist-contracts.test.ts src/api/__tests__/blacklist.test.ts src/api/__tests__/blacklist-summary.test.ts
```

Expected: all pass.

- [ ] **Step 6: Worker type-check + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

- [ ] **Step 7: Commit**

Use a concrete message that names the root cause, e.g.:

```bash
git add <files>
git commit -m "$(cat <<'EOM'
blacklist: fix <root-cause> triggering exception:Error on 8 configs

<2-3 sentences explaining the actual root cause uncovered in 2.1>

Unblocks ingestion for USDG (237 events on-chain), RLUSD (179),
USDO (≥170), EURC Ethereum/Base, EURI BSC, USDC Arbitrum (8.7 days
behind), USDC Base.

Fixes Agent A finding H3.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 2.3: Retro-replay historic coverage

**Files:** wrangler-only (DB mutation via admin endpoint)

**Parallel-safe:** no
**Blocked by:** Task 2.2 merged + deployed
**Commit:** none (ops action; document outcome in the diagnosis research file)

- [ ] **Step 1: Reset the 8 failing configs' sync-state cursors**

The standard `reset-blacklist-sync` admin endpoint only rolls back 50k blocks, which is insufficient for configs stuck at `zeroCursor` / `head - margin`. Use a direct D1 command:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
UPDATE blacklist_sync_state SET last_block = 0
WHERE config_key IN (
  'ethereum-0xe343167631d89b6ffc58b88d6b7fb0228795491d',
  'ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
  'ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe',
  'ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
  'base-0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
  'bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7',
  'arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
);"
```

Or, if a configKey has no existing row, insert it:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
INSERT OR REPLACE INTO blacklist_sync_state (config_key, last_block) VALUES
  ('ethereum-0xe343167631d89b6ffc58b88d6b7fb0228795491d', 0),
  ('ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed', 0),
  ('ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe', 0),
  ('ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c', 0),
  ('base-0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', 0),
  ('bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7', 0),
  ('arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831', 0),
  ('base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 0);"
```

- [ ] **Step 2: Wait for the next cron cycle and verify ingestion**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
SELECT stablecoin, chain_id, COUNT(*) AS cnt
FROM blacklist_events
WHERE stablecoin IN ('USDG','RLUSD','USDO','EURC','EURI')
   OR config_key IN (
     'ethereum-0xe343167631d89b6ffc58b88d6b7fb0228795491d',
     'ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
     'ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe',
     'ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
     'base-0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
     'bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7',
     'arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831',
     'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
   )
GROUP BY stablecoin, chain_id ORDER BY cnt DESC;"
```

Expected: non-zero counts for USDG/RLUSD/USDO. USDC Arbitrum should advance within 24 hours as the backlog drains.

- [ ] **Step 3: Monitor for 24 hours**

Check `cron_runs` once per cycle and confirm `apiErrorConfigs` no longer contains these configKeys.

- [ ] **Step 4: Update the research note**

Append an "Outcome" section to `agents/research/2026-04-16-blacklist-ah3-diagnosis.md` showing before/after counts. Commit as an amendment:

```bash
git add agents/research/2026-04-16-blacklist-ah3-diagnosis.md
git commit -m "$(cat <<'EOM'
blacklist: record Agent A H3 remediation outcome

Document the row counts for each previously-failing config before and
after the Phase 2 fix, confirming no residual exception:Error entries.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 2 completion gate:** zero entries in `apiErrorConfigs` for 24 consecutive sync-blacklist runs, and non-zero row counts for the previously-stranded configs.

---

## Phase 3 — Arbitrum `startBlock` Repair

> **Phase goal:** correct three wrong `startBlock` values on Arbitrum and force a re-scan. This phase is SERIAL because it mutates the same file (`blacklist-contracts.ts`) that later phases will also mutate, and the wrangler reset must happen after the code is deployed.

### Task 3.1: Correct the three Arbitrum `startBlock` values

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — three lines in `CONTRACT_CONFIG_SPECS`
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts` — regression assert

**Parallel-safe:** no
**Blocked by:** Phase 2 complete (so the same rescan doesn't trip the old exceptions)
**Commit:** C7

- [ ] **Step 1: Locate the three lines**

```bash
grep -n 'startBlock: 452_845_221\|startBlock: 431_248_926\|startBlock: 452_787_226' worker/src/lib/blacklist-contracts.ts
```

Expected: three matches (FDUSD Arbitrum, AUSD Arbitrum, BUIDL Arbitrum).

- [ ] **Step 2: Write a failing regression test**

Add to `worker/src/lib/__tests__/blacklist-contracts.test.ts`:

```ts
  it("uses corrected Arbitrum startBlocks for FDUSD/AUSD/BUIDL", () => {
    // Regression for Agent A H2: the original values were block numbers
    // from 2026-04-15 (chain head at audit time), which caused the first
    // sync to scan a zero-size window and permanently advance past the
    // actual deploy block.
    const getStartBlock = (stablecoinId: string, chainId: string) => {
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === stablecoinId && c.chain.chainId === chainId,
      );
      return config?.startBlock;
    };
    expect(getStartBlock("fdusd-first-digital", "arbitrum")).toBe(336_278_229);
    expect(getStartBlock("ausd-agora", "arbitrum")).toBe(342_153_906);
    expect(getStartBlock("buidl-blackrock", "arbitrum")).toBe(270_969_308);
  });
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts -t "corrected Arbitrum startBlocks"
```

Expected: FAIL with current values.

- [ ] **Step 4: Apply the fix**

Edit the three spec entries:

```ts
  { chain: ARBITRUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, events: USD1_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 342_153_906, events: ACCOUNT_FREEZE_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 270_969_308, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
```

- [ ] **Step 5: Re-run the test**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts -t "corrected Arbitrum startBlocks"
```

Expected: PASS.

- [ ] **Step 6: Run the full contracts test suite**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts
```

- [ ] **Step 7: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/lib/__tests__/blacklist-contracts.test.ts
git commit -m "$(cat <<'EOM'
blacklist: correct Arbitrum startBlocks for FDUSD/AUSD/BUIDL

The declared values (452_845_221 / 431_248_926 / 452_787_226) were all
near-chain-head at the time of config authorship, so the first scan saw
a tiny/empty window and advanced sync_state to head - margin via the
no-events path. Correct to the real deployment blocks verified against
Blockscout creation-tx metadata (336M / 342M / 271M) — giving 11mo,
8.5mo, and 17.5mo of previously-skipped history respectively.

Requires the accompanying blacklist_sync_state reset (Task 3.2) so the
cursor re-scans from the corrected start block.

Fixes Agent A finding H2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 3.2: Hard-reset the three sync-state cursors

**Files:** wrangler-only

**Parallel-safe:** no
**Blocked by:** Task 3.1 deployed to production
**Commit:** none (ops action)

- [ ] **Step 1: Dry-run the update**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
SELECT config_key, last_block FROM blacklist_sync_state
WHERE config_key IN (
  'arbitrum-0x93c92f6b2cf5e6d27b7c3f2c7f5bf2e9b1e8099fe',
  'arbitrum-0x00000000efe302beaa2b3e6e1b18d1f68285012a',
  'arbitrum-0xa6525ae43edcd03dc08e775774dcabd3bc925872'
);"
```

Compare the exact config_key values with the ones in `CONTRACT_CONFIGS`; these are examples — confirm the real keys with:

```bash
cd worker && node -e "
const { CONTRACT_CONFIGS } = require('./dist/lib/blacklist-contracts');
for (const c of CONTRACT_CONFIGS) {
  if (c.chain.chainId === 'arbitrum' && ['fdusd-first-digital','ausd-agora','buidl-blackrock'].includes(c.stablecoinId)) {
    console.log(c.configKey);
  }
}
"
```

(or just run a TS import in a quick script — use whatever is convenient)

- [ ] **Step 2: Apply the reset**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
UPDATE blacklist_sync_state SET last_block = 0
WHERE config_key IN (
  '<fdusd arbitrum key>',
  '<ausd arbitrum key>',
  '<buidl arbitrum key>'
);"
```

- [ ] **Step 3: Wait for the next sync-blacklist cycle**

Watch the hourly run's `cron_runs.metadata` for these three configs to reappear with non-zero event counts.

---

### Task 3.3: Verify catch-up progress

**Files:** wrangler-only

**Parallel-safe:** no
**Blocked by:** Task 3.2 complete and at least 2 sync cycles passed
**Commit:** none

- [ ] **Step 1: Confirm row counts**

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "
SELECT stablecoin, chain_id, COUNT(*) AS cnt, MIN(timestamp) AS oldest, MAX(timestamp) AS newest
FROM blacklist_events
WHERE chain_id = 'arbitrum'
  AND stablecoin IN ('FDUSD','AUSD','BUIDL')
GROUP BY stablecoin, chain_id
ORDER BY stablecoin;"
```

If any row count is still 0, confirm by querying a public Etherscan endpoint whether any events actually exist in the freshly-covered historical range, so we know whether the zero is a real zero or a scan failure.

- [ ] **Step 2: Log outcome to the research file**

Append to `agents/research/2026-04-16-blacklist-ah3-diagnosis.md` a "Phase 3 outcome" section with the observed counts. Commit as an amendment.

---

**Phase 3 completion gate:** the three Arbitrum sync-state rows show `last_block` advancing past the correct deploy blocks on at least one complete cron cycle, and row counts reflect real on-chain history (or an explicit note that no such events exist).

---

## Phase 4 — Coverage Expansion

> **Phase goal:** extend the tracker to cover the gaps Agent B identified. All tasks touch `worker/src/lib/blacklist-contracts.ts` and the associated test file, so they must SERIALIZE. Group them into one thematic PR per sub-phase, or run them as back-to-back subagent dispatches.

### Task 4.1: Extend `wlfi-freeze` family with drain/reallocate destroy events

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — `USD1_EVENT_FAMILY`
- Test: `worker/src/cron/blacklist/__tests__/evm-source.test.ts` — new cases

**Parallel-safe:** no
**Blocked by:** Phase 3 complete (so we don't stack unrelated changes on the same file)
**Commit:** C8

Background: USD1 `StablecoinV2` also emits `FrozenAccountDrained(address,address,uint256)` and `FrozenFundsReallocated(address,address,address,uint256)`. Topic hashes are pre-computed at the top of this plan. The family is reused by U/FDUSD/EURI so all four coins gain destroy-event coverage.

- [ ] **Step 1: Verify topic hashes with the live node command**

```bash
node -e '
const { keccak256, toBytes } = require("viem");
console.log("FrozenAccountDrained", keccak256(toBytes("FrozenAccountDrained(address,address,uint256)")));
console.log("FrozenFundsReallocated", keccak256(toBytes("FrozenFundsReallocated(address,address,address,uint256)")));
'
```

Expected output:
```
FrozenAccountDrained 0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef
FrozenFundsReallocated 0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a
```

If the output differs, STOP — do not commit. Re-verify the signature strings character-by-character before proceeding.

- [ ] **Step 2: Verify event presence on the USD1 mainnet contract**

```bash
curl -s 'https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d&topic0=0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef&fromBlock=0&toBlock=latest' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("rows:", len(d.get("result",[])))'

curl -s 'https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d&topic0=0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a&fromBlock=0&toBlock=latest' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("rows:", len(d.get("result",[])))'
```

Non-zero count confirms the signature/topic hash is right. Zero is OK (the contract may simply have no drains yet) — in that case add a note to the commit message.

- [ ] **Step 2a: Verify indexed-param layout before writing tests (ABI cross-check)**

The plan assumes `FrozenAccountDrained(address caller, address account, uint256 amount)` has BOTH `caller` and `account` indexed (→ `addressTopicIndex: 2`, `amountDataIndex: 0`), and `FrozenFundsReallocated(address caller, address from, address to, uint256 amount)` has `caller` and `from` indexed (→ `addressTopicIndex: 2`, `amountDataIndex: 1`).

These assumptions must be confirmed against the verified StablecoinV2 ABI before wiring the event family — wrong `indexed` flags will silently parse wrong addresses/amounts.

```bash
# Pull the implementation ABI from Etherscan's getsourcecode endpoint.
# The USD1 proxy's implementation address:
curl -s 'https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=0x694Aa534bdef8ed63244eb902e7914e527891f08' \
  | python3 -c '
import json, sys, re
data = json.load(sys.stdin)
src = data["result"][0]["SourceCode"] or ""
for sig in ("FrozenAccountDrained", "FrozenFundsReallocated"):
  for m in re.finditer(rf"event\s+{sig}\s*\(([^)]+)\)", src):
    print(f"--- {sig} ---")
    print(m.group(1).strip())
'
```

Expected output example:
```
--- FrozenAccountDrained ---
address indexed caller, address indexed account, uint256 amount
--- FrozenFundsReallocated ---
address indexed caller, address indexed from, address to, uint256 amount
```

If the real declaration shows a different `indexed` pattern, STOP and update the `addressTopicIndex` / `amountDataIndex` / `addressDataIndex` values in Step 5 accordingly BEFORE writing tests. Otherwise, proceed.

Alternative: if Etherscan returns `SourceCode: ""` (flattened-only or proxy without verification), fetch a single real `FrozenFundsReallocated` log via the curl command in Step 2, read its `topics.length` (3 means dual-indexed, 2 means single-indexed), and reason from there. If no real logs exist AND source is unavailable, defer Task 4.1 entirely with a note in the PR description.

- [ ] **Step 3: Write failing tests for both new events**

Append to `worker/src/cron/blacklist/__tests__/evm-source.test.ts`:

```ts
  describe("wlfi-freeze destroy events", () => {
    it("parses FrozenAccountDrained with victim at topics[2] and amount at data slot 0", async () => {
      const { encodeAbiParameters, pad } = await import("viem");
      const victim = "0x" + "aa".repeat(20);
      const caller = "0x" + "bb".repeat(20);
      const topic0 = "0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef";
      const data = encodeAbiParameters([{ type: "uint256" }], [1_000_000_000_000_000_000n]);
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === "usd1-world-liberty-financial" && c.chain.chainId === "ethereum",
      )!;
      const rows = parseEvmLogs(config, [
        {
          address: config.contractAddress,
          topics: [topic0, pad(caller), pad(victim)],
          data,
          blockNumber: "0x100",
          transactionHash: "0xdeadbeef".padEnd(66, "0"),
          logIndex: "0x0",
          timeStamp: "0x1000",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("destroy");
      expect(rows[0].address.toLowerCase()).toBe(victim);
      expect(rows[0].amount_native).toBe(1);
    });

    it("parses FrozenFundsReallocated with `from` victim at topics[2] and amount at data slot 1", async () => {
      const { encodeAbiParameters, pad } = await import("viem");
      const caller = "0x" + "11".repeat(20);
      const from = "0x" + "22".repeat(20);
      const to = "0x" + "33".repeat(20);
      const topic0 = "0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a";
      // Data layout for FrozenFundsReallocated is (address to, uint256 amount) after
      // dropping the two indexed params.
      const data = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [to as `0x${string}`, 2_000_000_000_000_000_000n],
      );
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === "usd1-world-liberty-financial" && c.chain.chainId === "ethereum",
      )!;
      const rows = parseEvmLogs(config, [
        {
          address: config.contractAddress,
          topics: [topic0, pad(caller), pad(from)],
          data,
          blockNumber: "0x101",
          transactionHash: "0xfeedface".padEnd(66, "0"),
          logIndex: "0x0",
          timeStamp: "0x1001",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("destroy");
      expect(rows[0].address.toLowerCase()).toBe(from);
      expect(rows[0].amount_native).toBe(2);
    });
  });
```

- [ ] **Step 4: Run the new tests and confirm FAIL**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts -t "wlfi-freeze destroy"
```

Expected: FAIL — `getBlacklistEventByTopic` will not find the new topic hashes in the family yet.

- [ ] **Step 5: Extend `USD1_EVENT_FAMILY`**

Edit `worker/src/lib/blacklist-contracts.ts`. After the existing `USD1_UNFREEZE_TOPIC` declaration, add:

```ts
const WLFI_FROZEN_DRAINED_TOPIC = "0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef"; // FrozenAccountDrained(address,address,uint256)
const WLFI_FROZEN_REALLOCATED_TOPIC = "0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a"; // FrozenFundsReallocated(address,address,address,uint256)
```

Then extend the `USD1_EVENT_FAMILY` definition:

```ts
const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "FrozenAccountDrained(address,address,uint256)",
    topicHash: WLFI_FROZEN_DRAINED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    // `from` (victim) is the second indexed param.
    addressTopicIndex: 2,
    // Non-indexed tail is `uint256 amount` — first data slot.
    amountDataIndex: 0,
    tronResultKey: "account",
  },
  {
    signature: "FrozenFundsReallocated(address,address,address,uint256)",
    topicHash: WLFI_FROZEN_REALLOCATED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    // Two indexed params: caller (topics[1]) and `from` (topics[2]).
    // Non-indexed tail: `(address to, uint256 amount)`.
    addressTopicIndex: 2,
    amountDataIndex: 1,
    tronResultKey: "account",
  },
]);
```

- [ ] **Step 6: Re-run the tests**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
```

Expected: all pass, including the two new cases.

- [ ] **Step 7: Run the full contracts test suite**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts
```

- [ ] **Step 8: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts
git commit -m "$(cat <<'EOM'
blacklist: extend wlfi-freeze with FrozenAccountDrained + FrozenFundsReallocated

The USD1 StablecoinV2 implementation emits drain and reallocation events
when admins remove funds from frozen accounts. The previous wlfi-freeze
family only covered Freeze/Unfreeze, so destroy-family coverage was
missing for all four coins that share this family: USD1, U, FDUSD, EURI.

Adds both topic hashes (pre-computed via keccak256), binds the victim
address to topics[2], and wires amount extraction from data slot 0
(Drained: `uint256 amount`) or data slot 1 (Reallocated: `(address to,
uint256 amount)`).

Fixes Agent B finding P0.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.2: Add USDC coverage on Linea, Sonic, Unichain, Worldchain, Celo

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — chain constants + CONTRACT_CONFIG_SPECS entries
- Modify: `shared/data/stablecoins/usd-major.json` only if `usdc-circle.contracts` is missing one of these chains (check first)
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts` — assert each new config resolves

**Parallel-safe:** no (same file)
**Blocked by:** 4.1
**Commit:** C9

- [ ] **Step 0: Export the reusable event families (prerequisite for 4.2/4.3/4.4/4.5 tests)**

`USDC_EVENT_FAMILY`, `USDT0_EVENT_FAMILY`, and `PYUSD_EVENT_FAMILY` are currently declared with `const X = defineEventFamily(...)` — module-private. The test assertions in Tasks 4.2/4.3/4.4/4.5 compare the config's `.events` array against these constants by referencing them from the test file, which requires them to be exported. Add `export` in front of each declaration **once**, here at the start of Task 4.2:

```ts
// In worker/src/lib/blacklist-contracts.ts, change the three declarations to:
export const USDC_EVENT_FAMILY = defineEventFamily("circle-blacklist", [...]);
export const USDT0_EVENT_FAMILY = defineEventFamily("tether-indexed-blacklist", [...]);
export const PYUSD_EVENT_FAMILY = defineEventFamily("paxos-pyusd-freeze", [...]);
```

Do NOT export the legacy USDT family or any of the new wave-2a families — only the three constants that the Tasks 4.2/4.3/4.4/4.5 tests need. This avoids churning the public surface of `blacklist-contracts.ts` unnecessarily.

Confirm via `grep`:

```bash
grep -E '^export const (USDC|USDT0|PYUSD)_EVENT_FAMILY' worker/src/lib/blacklist-contracts.ts
```

Expected: three lines.

- [ ] **Step 1: Confirm the 5 chains already exist in CHAIN_META**

```bash
grep -E 'linea|sonic|unichain|worldchain|celo' shared/lib/chains.ts
```

Each chain should have a `CHAIN_META` entry with `type: "evm"`, a numeric `evmChainId`, a valid `explorerUrl`, and a `name`. If any is missing, STOP and flag it for the user — this plan does not include chain-registry expansion.

- [ ] **Step 2: Confirm each chain's USDC contract is declared in `usdc-circle.contracts`**

```bash
jq '.contracts' shared/data/stablecoins/usd-major.json | grep -E '"linea"|"sonic"|"unichain"|"worldchain"|"celo"'
```

Every chain that has no entry must be added via a PR-internal JSON update first. Preserve the exact schema the file already uses.

- [ ] **Step 3: Smoke-test each new address with a single `eth_getLogs` for the Blacklisted topic**

```bash
for pair in \
  "59144 0x176211869cA2b568f2A7D4EE941E073a821EE1ff" \
  "146   0x29219dd400f2Bf60E5a23d13Be72B486D4038894" \
  "130   0x078d782b760474a361dDA0AF3839290b0EF57AD6" \
  "480   0x79A02482A880bCe3F13E09da970dC34dB4cD24D1" \
  "42220 0xcebA9300f2b948710d2653dD7B07f33A8B32118C" ; do
  chain=$(echo $pair | awk '{print $1}')
  addr=$(echo $pair | awk '{print $2}')
  echo "--- chain $chain addr $addr ---"
  curl -s "https://api.etherscan.io/v2/api?chainid=$chain&module=logs&action=getLogs&address=$addr&topic0=0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855&fromBlock=0&toBlock=latest&offset=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:", d.get("status"), "result_type:", type(d.get("result")).__name__, "sample:", str(d.get("result"))[:200])'
done
```

If any chain returns `status != "1"` with a non-empty result, record the reason in the commit message before proceeding. Zero-result chains are fine — the config still advances the cursor from the deploy block forward.

- [ ] **Step 4: Write the failing resolution test**

Add to `worker/src/lib/__tests__/blacklist-contracts.test.ts`:

```ts
  it.each([
    ["linea"],
    ["sonic"],
    ["unichain"],
    ["worldchain"],
    ["celo"],
  ])("resolves usdc-circle on %s with USDC event family", (chainId) => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdc-circle" && c.chain.chainId === chainId,
    );
    expect(config).toBeDefined();
    expect(config!.events).toEqual(USDC_EVENT_FAMILY.events);
  });
```

(`USDC_EVENT_FAMILY` is exported from `blacklist-contracts.ts`; if it isn't, import-check and temporarily export it for test use.)

- [ ] **Step 5: Run the new test and confirm FAIL**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts -t "resolves usdc-circle"
```

- [ ] **Step 6: Add the chain constants + config rows**

Near the existing chain-constant block (around line 72 of `blacklist-contracts.ts`):

```ts
const LINEA      = chainConfig("linea");
const SONIC      = chainConfig("sonic");
const UNICHAIN   = chainConfig("unichain");
const WORLDCHAIN = chainConfig("worldchain");
const CELO       = chainConfig("celo");
```

Inside `CONTRACT_CONFIG_SPECS`, after the existing USDC block:

```ts
  { chain: LINEA,      stablecoinId: "usdc-circle", startBlock: <verified deploy block>, events: USDC_EVENT_FAMILY.events },
  { chain: SONIC,      stablecoinId: "usdc-circle", startBlock: <verified deploy block>, events: USDC_EVENT_FAMILY.events },
  { chain: UNICHAIN,   stablecoinId: "usdc-circle", startBlock: <verified deploy block>, events: USDC_EVENT_FAMILY.events },
  { chain: WORLDCHAIN, stablecoinId: "usdc-circle", startBlock: <verified deploy block>, events: USDC_EVENT_FAMILY.events },
  { chain: CELO,       stablecoinId: "usdc-circle", startBlock: <verified deploy block>, events: USDC_EVENT_FAMILY.events },
```

Where `<verified deploy block>` is the block at which the USDC FiatTokenV2 was deployed on that chain. Retrieve via:

```bash
# Example for Linea (replace for each chain)
curl -s "https://api.etherscan.io/v2/api?chainid=59144&module=contract&action=getcontractcreation&contractaddresses=0x176211869cA2b568f2A7D4EE941E073a821EE1ff" | python3 -m json.tool
```

Record each block number in the commit message.

- [ ] **Step 7: Run the full blacklist test suite**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts src/cron/blacklist src/api/__tests__/blacklist.test.ts
```

- [ ] **Step 8: Worker type-check + lint**

```bash
cd worker && npx tsc --noEmit && cd ..
npm run lint
```

- [ ] **Step 9: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/lib/__tests__/blacklist-contracts.test.ts shared/data/stablecoins/usd-major.json
git commit -m "$(cat <<'EOM'
blacklist: add USDC coverage on Linea/Sonic/Unichain/Worldchain/Celo

Circle deploys the same FiatTokenV2_2 proxy with the standard
Blacklisted/UnBlacklisted event surface on these five chains. Each config
reuses USDC_EVENT_FAMILY and seeds sync from the verified deploy block.

Verified via Etherscan-v2 contract lookups:
- Linea:      <block>  (0x176211869cA2b568f2A7D4EE941E073a821EE1ff)
- Sonic:      <block>  (0x29219dd400f2Bf60E5a23d13Be72B486D4038894)
- Unichain:   <block>  (0x078d782b760474a361dDA0AF3839290b0EF57AD6)
- Worldchain: <block>  (0x79A02482A880bCe3F13E09da970dC34dB4cD24D1)
- Celo:       <block>  (0xcebA9300f2b948710d2653dD7B07f33A8B32118C)

Fixes Agent B finding P1 (USDC chain gaps).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.3: Add USDT0 coverage on 11 new chains

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — new chain constants + config specs
- Modify: `shared/data/stablecoins/usd-major.json` if `usdt-tether.contracts` is missing a chain (Rootstock/Conflux/Morph)
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

**Parallel-safe:** no (same file as 4.1–4.2)
**Blocked by:** 4.2
**Commit:** C10

Target chains (USDT0 Token, LayerZero-rolled): Ink, Berachain, Mantle, Sei, HyperEVM, Unichain, Monad, Flare, Plasma, XLayer, Corn. Addresses per Agent B report (verified against `docs.usdt0.to`).

- [ ] **Step 1: Confirm CHAIN_META entries exist**

```bash
for c in ink berachain mantle sei hyperevm unichain monad flare plasma xlayer corn; do
  grep -q "$c" shared/lib/chains.ts && echo "$c: ok" || echo "$c: MISSING"
done
```

Each `MISSING` chain is OUT OF SCOPE for this task — skip it in the config and note the skip in the commit message. Do NOT add chain-registry entries as part of this plan.

- [ ] **Step 2: Confirm `usdt-tether.contracts` has an entry for each non-skipped chain**

```bash
jq '.contracts | keys' shared/data/stablecoins/usd-major.json | grep -Ei 'ink|berachain|mantle|sei|hyperevm|unichain|monad|flare|plasma|xlayer|corn'
```

For any missing entry, add the address to the JSON first (preserving whatever schema already exists). Record which chains needed JSON updates.

- [ ] **Step 3: Smoke-test each address against USDT0 topics**

```bash
for pair in \
  "7887     0x0200C29006150606B650577BBE7B6248F58470c1" \
  "80094    0x779Ded0c9e1022225f8E0630b35a9b54bE713736" \
  "5000     0x779Ded0c9e1022225f8E0630b35a9b54bE713736" \
  "1329     0x9151434b16b9763660705744891fA906F660EcC5" \
  "999      0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" \
  "130      0x9151434b16b9763660705744891fA906F660EcC5" \
  "143      0xe7cd86e13AC4309349F30B3435a9d337750fC82D" \
  "14       0xe7cd86e13AC4309349F30B3435a9d337750fC82D" \
  "9745     0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" \
  "196      0x779Ded0c9e1022225f8E0630b35a9b54bE713736" \
  "21000000 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" ; do
  chain=$(echo $pair | awk '{print $1}')
  addr=$(echo $pair | awk '{print $2}')
  echo "--- chain $chain addr $addr ---"
  curl -s "https://api.etherscan.io/v2/api?chainid=$chain&module=logs&action=getLogs&address=$addr&topic0=0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7&fromBlock=0&toBlock=latest&offset=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:", d.get("status"), "sample:", str(d.get("result"))[:150])' || echo "FAILED"
done
```

Chain IDs are indicative — verify each against `CHAIN_META[chainId].evmChainId` before passing to Etherscan v2. Any chain where Etherscan v2 does not yet support the chainId should be flagged in the commit and SKIPPED (the config would compile but never ingest).

- [ ] **Step 4: Write failing tests**

Add to `worker/src/lib/__tests__/blacklist-contracts.test.ts`:

```ts
  it.each([
    ["ink"],
    ["berachain"],
    ["mantle"],
    ["sei"],
    ["hyperevm"],
    ["unichain"],
    ["monad"],
    ["flare"],
    ["plasma"],
    ["xlayer"],
    ["corn"],
  ])("resolves usdt-tether on %s with USDT0 event family", (chainId) => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdt-tether" && c.chain.chainId === chainId,
    );
    // Chains skipped because they lack CHAIN_META entries or Etherscan-v2
    // support must be filtered OUT of this .each list manually; keep
    // the list in sync with the actual config additions.
    expect(config).toBeDefined();
    expect(config!.events).toEqual(USDT0_EVENT_FAMILY.events);
  });
```

- [ ] **Step 5: Confirm tests FAIL**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts -t "resolves usdt-tether"
```

- [ ] **Step 6: Add chain constants + config entries**

Append chain constants near the existing block:

```ts
const INK        = chainConfig("ink");
const BERACHAIN  = chainConfig("berachain");
const MANTLE     = chainConfig("mantle");
const SEI        = chainConfig("sei");
const HYPEREVM   = chainConfig("hyperevm");
// UNICHAIN already declared in Task 4.2
const MONAD      = chainConfig("monad");
const FLARE      = chainConfig("flare");
const PLASMA     = chainConfig("plasma");
const XLAYER     = chainConfig("xlayer");
const CORN       = chainConfig("corn");
```

For each non-skipped chain, add a spec entry. Example for Ink:

```ts
  { chain: INK, stablecoinId: "usdt-tether", contractAddressOverride: "0x0200C29006150606B650577BBE7B6248F58470c1", startBlock: <deploy block>, events: USDT0_EVENT_FAMILY.events },
```

Use `contractAddressOverride` when the canonical JSON listing uses a different preferred address, or omit the override when the JSON already points at the USDT0 Token. Deploy blocks via Etherscan-v2 `getcontractcreation`.

- [ ] **Step 7: Run tests + type-check**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/lib/__tests__/blacklist-contracts.test.ts shared/data/stablecoins/usd-major.json
git commit -m "$(cat <<'EOM'
blacklist: add USDT0 Token coverage on N LayerZero chains

Tether's USDT0 rollout runs the same BlockPlaced/BlockReleased/
DestroyedBlockedFunds event surface already implemented in
USDT0_EVENT_FAMILY. Add config rows for each LayerZero chain verified
against docs.usdt0.to and smoke-tested via Etherscan v2:

- Ink        (<address>, deploy <block>)
- Berachain  (<address>, deploy <block>)
- Mantle     (<address>, deploy <block>)
- Sei        (<address>, deploy <block>)
- HyperEVM   (<address>, deploy <block>)
- Unichain   (<address>, deploy <block>)
- Monad      (<address>, deploy <block>)
- Flare      (<address>, deploy <block>)
- Plasma     (<address>, deploy <block>)
- XLayer     (<address>, deploy <block>)
- Corn       (<address>, deploy <block>)

Skipped: <any chain lacking CHAIN_META or Etherscan-v2 support>
(rationale in PR description).

Fixes Agent B finding P1 (USDT0 chain gaps).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.4: Add USDP (Paxos Pax Dollar) coverage

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — new spec entry
- Modify: `shared/types/market.ts` — add `"USDP"` to `BLACKLIST_STABLECOINS`
- Modify: `shared/data/stablecoins/usd-minor.json` — verify `usdp-paxos` exists with an Ethereum contract entry
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

**Parallel-safe:** no
**Blocked by:** 4.3
**Commit:** C11

- [ ] **Step 1: Confirm `usdp-paxos` is declared in the JSON**

```bash
jq '."usdp-paxos"' shared/data/stablecoins/usd-minor.json 2>/dev/null || jq '.[] | select(.id=="usdp-paxos")' shared/data/stablecoins/usd-minor.json 2>/dev/null
```

If USDP is missing entirely, STOP — adding a new tracked-stablecoin JSON entry is out of scope for this plan and needs explicit user approval.

- [ ] **Step 2: Smoke-test the Paxos freeze event hashes against USDP**

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=0x8e870d67f660d95d5be530380d0ec0bd388289e1&topic0=0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392&fromBlock=0&toBlock=latest&offset=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:", d.get("status"), "result:", str(d.get("result"))[:200])'
```

A valid response confirms the PYUSD event family applies.

- [ ] **Step 3: Add `USDP` to the enum**

Edit `shared/types/market.ts`, inside `BLACKLIST_STABLECOINS`:

```ts
export const BLACKLIST_STABLECOINS = [
  "USDC",
  "USDT",
  "PAXG",
  "XAUT",
  "PYUSD",
  "USD1",
  "USDG",
  "RLUSD",
  "U",
  "USDTB",
  "A7A5",
  "FDUSD",
  "BRZ",
  "AUSD",
  "MNEE",
  "EURI",
  "USDQ",
  "USDO",
  "USDX",
  "AID",
  "TGBP",
  "EURC",
  "BUIDL",
  "USDP",  // Paxos Pax Dollar — added v3.91
] as const;
```

(Maintain wave-order chronology; update the comment to mention v3.91.)

- [ ] **Step 4: Write failing test**

Add to `worker/src/lib/__tests__/blacklist-contracts.test.ts`:

```ts
  it("resolves usdp-paxos on ethereum with PYUSD event family", () => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdp-paxos" && c.chain.chainId === "ethereum",
    );
    expect(config).toBeDefined();
    expect(config!.stablecoin).toBe("USDP");
    expect(config!.events).toEqual(PYUSD_EVENT_FAMILY.events);
  });
```

- [ ] **Step 5: Confirm FAIL**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts -t "usdp-paxos"
```

- [ ] **Step 6: Add the spec entry**

Inside `CONTRACT_CONFIG_SPECS`:

```ts
  { chain: ETHEREUM, stablecoinId: "usdp-paxos", stablecoin: "USDP", startBlock: <deploy block>, events: PYUSD_EVENT_FAMILY.events },
```

Retrieve the Ethereum deploy block via:

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation&contractaddresses=0x8e870d67f660d95d5be530380d0ec0bd388289e1" | python3 -m json.tool
```

- [ ] **Step 7: Worker tsc + full tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts src/api/__tests__/blacklist.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts shared/types/market.ts worker/src/lib/__tests__/blacklist-contracts.test.ts
git commit -m "$(cat <<'EOM'
blacklist: add USDP Paxos coverage on Ethereum

USDP (Pax Dollar, proxy 0x8e87...89e1) uses the same Paxos freeze
pattern as PYUSD/USDG — FreezeAddress, UnfreezeAddress,
FrozenAddressWiped — so configuration reuses PYUSD_EVENT_FAMILY.
Promote USDP into BLACKLIST_STABLECOINS for API/UI exposure.

Fixes Agent B finding P1 (USDP gap).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.5: Add EURC Worldchain coverage

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`
- Modify: `shared/data/stablecoins/non-usd.json` (only if missing)
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

**Parallel-safe:** no
**Blocked by:** 4.4
**Commit:** C12

- [ ] **Step 1: Verify the address is a Circle FiatTokenV2 proxy**

```bash
curl -s 'https://worldchain-mainnet.g.alchemy.com/public' -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b","latest"]}' | head -c 500
```

Confirm non-empty bytecode. Then check Worldchain explorer for contract verification ("Circle: USDC Token" or similar branding).

- [ ] **Step 2: Smoke-test Circle Blacklisted topic**

```bash
# Worldchain chainId via CHAIN_META (verify first)
WORLDCHAIN_ID=$(grep -A2 'worldchain' shared/lib/chains.ts | grep evmChainId | head -1 | sed 's/[^0-9]//g')
echo "worldchain id: $WORLDCHAIN_ID"
curl -s "https://api.etherscan.io/v2/api?chainid=$WORLDCHAIN_ID&module=logs&action=getLogs&address=0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b&topic0=0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855&fromBlock=0&toBlock=latest&offset=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:", d.get("status"), "sample:", str(d.get("result"))[:200])'
```

If the response is not `status: "1"`, stop and flag — Etherscan v2 may not index Worldchain yet. In that case, move this task to Phase 8 (pending explorer support).

- [ ] **Step 3: Write failing test**

```ts
  it("resolves eurc-circle on worldchain with USDC event family", () => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "eurc-circle" && c.chain.chainId === "worldchain",
    );
    expect(config).toBeDefined();
    expect(config!.events).toEqual(USDC_EVENT_FAMILY.events);
  });
```

- [ ] **Step 4: Add the config row**

```ts
  { chain: WORLDCHAIN, stablecoinId: "eurc-circle", startBlock: <deploy block>, events: USDC_EVENT_FAMILY.events },
```

- [ ] **Step 5: Run tests + type-check, then commit**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts && npx tsc --noEmit
git add worker/src/lib/blacklist-contracts.ts worker/src/lib/__tests__/blacklist-contracts.test.ts shared/data/stablecoins/non-usd.json
git commit -m "$(cat <<'EOM'
blacklist: add EURC Worldchain coverage

Circle deploys the same FiatTokenV2 surface on Worldchain
(0x1c60ba0a...2380b). Reuses USDC_EVENT_FAMILY. Seeded from verified
deploy block <block>.

Fixes Agent B finding P1 (EURC Worldchain).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.6: Add TUSD with bool-param event decoder

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts` — new TUSD_EVENT_FAMILY
- Modify: `worker/src/cron/blacklist/evm-source.ts` — decoder change for bool-derived event type
- Modify: `shared/types/market.ts` — add `"TUSD"` to enum
- Modify: `shared/data/stablecoins/usd-minor.json` (only if missing)
- Test: `worker/src/cron/blacklist/__tests__/evm-source.test.ts`
- Test: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

**Parallel-safe:** no
**Blocked by:** 4.5
**Commit:** C13

Background: TUSD emits `Blacklisted(address indexed account, bool isBlacklisted)` — a single event where the boolean data field determines `blacklist` vs `unblacklist`. The existing parser assumes one `eventType` per topic hash. Add an optional `eventTypeFromBoolSlot` decoder extension on `BlacklistEventDef`.

- [ ] **Step 1: Extend `BlacklistEventDef`**

In `worker/src/lib/blacklist-contracts.ts`:

```ts
export interface BlacklistEventDef {
  signature: string;
  topicHash: string;
  eventType: BlacklistEventType;
  hasAmount: boolean;
  addressTopicIndex?: number;
  addressDataIndex?: number;
  addressArrayData?: boolean;
  amountTopicIndex?: number;
  amountDataIndex?: number;
  tronResultKey?: string;
  /**
   * When set, the parser OVERRIDES `eventType` by reading a bool from
   * this 32-byte data slot: true → `blacklist`, false → `unblacklist`.
   * Used for TUSD's `Blacklisted(address,bool)` pattern where a single
   * topic encodes both actions.
   */
  eventTypeFromBoolSlot?: number;
}
```

- [ ] **Step 2: Declare TUSD topic + family**

```ts
const TUSD_BLACKLISTED_TOPIC = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8"; // Blacklisted(address,bool)
const TUSD_DESTROYED_FUNDS_TOPIC = USDT_DESTROYED_FUNDS_TOPIC; // DestroyedBlackFunds(address,uint256) — same signature as USDT legacy

const TUSD_EVENT_FAMILY = defineEventFamily("trueusd-blacklist", [
  {
    signature: "Blacklisted(address,bool)",
    topicHash: TUSD_BLACKLISTED_TOPIC,
    eventType: "blacklist", // fallback; overridden by the bool slot
    hasAmount: false,
    // `account` is indexed at topics[1]; `isBlacklisted` bool is non-indexed, slot 0.
    eventTypeFromBoolSlot: 0,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: TUSD_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    // TUSD destroy mirrors USDT legacy layout (non-indexed address + amount).
  },
]);
```

- [ ] **Step 3: Add `"TUSD"` to `BLACKLIST_STABLECOINS`**

Same pattern as Task 4.4.

- [ ] **Step 4: Add the ETHEREUM config row**

```ts
  { chain: ETHEREUM, stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: <deploy block>, events: TUSD_EVENT_FAMILY.events },
```

The real deploy block for `0x0000000000085d4780b73119b644ae5ecd22b376` via Etherscan v2 `getcontractcreation`.

- [ ] **Step 5: Write failing test for the bool-slot decoder**

Append to `evm-source.test.ts`:

```ts
  describe("TUSD bool-slot event type", () => {
    it("derives blacklist when bool data slot is true", async () => {
      const { pad, toHex } = await import("viem");
      const account = "0x" + "aa".repeat(20);
      const topic0 = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8";
      const data = toHex(1n, { size: 32 }); // bool = true
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === "tusd-trueusd" && c.chain.chainId === "ethereum",
      )!;
      const rows = parseEvmLogs(config, [
        {
          address: config.contractAddress,
          topics: [topic0, pad(account)],
          data,
          blockNumber: "0x200",
          transactionHash: "0xaabbcc".padEnd(66, "0"),
          logIndex: "0x0",
          timeStamp: "0x2000",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("blacklist");
      expect(rows[0].address.toLowerCase()).toBe(account);
    });

    it("derives unblacklist when bool data slot is false", async () => {
      const { pad, toHex } = await import("viem");
      const account = "0x" + "bb".repeat(20);
      const topic0 = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8";
      const data = toHex(0n, { size: 32 }); // bool = false
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === "tusd-trueusd" && c.chain.chainId === "ethereum",
      )!;
      const rows = parseEvmLogs(config, [
        {
          address: config.contractAddress,
          topics: [topic0, pad(account)],
          data,
          blockNumber: "0x201",
          transactionHash: "0xccdd".padEnd(66, "0"),
          logIndex: "0x0",
          timeStamp: "0x2001",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe("unblacklist");
    });
  });
```

- [ ] **Step 6: Confirm tests FAIL**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts -t "TUSD bool-slot"
```

- [ ] **Step 7: Implement the bool-slot decoder in `parseEvmLogs`**

In `worker/src/cron/blacklist/evm-source.ts`, inside `parseEvmLogs`, after the address extraction and before building the row, resolve the effective event type:

```ts
    let effectiveEventType = eventDef.eventType;
    if (typeof eventDef.eventTypeFromBoolSlot === "number") {
      const slotIdx = eventDef.eventTypeFromBoolSlot;
      const cleaned = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      const slot = cleaned.slice(slotIdx * 64, slotIdx * 64 + 64);
      const asBigInt = slot.length === 64 ? BigInt("0x" + slot) : 0n;
      effectiveEventType = asBigInt !== 0n ? "blacklist" : "unblacklist";
    }
```

Then use `effectiveEventType` when building the row. The existing `buildBlacklistRow` reads the event type from `getBlacklistEventByTopic(config, log.topics[0])?.eventType`, so it must be overridden.

- [ ] **Step 7a: Extend `buildBlacklistRow` with an `eventTypeOverride` parameter**

The function declaration is currently at `worker/src/cron/blacklist/evm-source.ts:88-128` with signature:

```ts
function buildBlacklistRow(
  config: ContractEventConfig,
  log: EvmLogLike,
  affectedAddress: string,
  amount: number | null,
  blockNumber: number,
  timestamp: number,
  rowSuffix = "",
): BlacklistRow | null {
  const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
  if (!eventDef) return null;
  // ...
  return {
    // ...
    event_type: eventDef.eventType,
    // ...
  };
}
```

Add a trailing optional parameter and use it when present:

```ts
function buildBlacklistRow(
  config: ContractEventConfig,
  log: EvmLogLike,
  affectedAddress: string,
  amount: number | null,
  blockNumber: number,
  timestamp: number,
  rowSuffix = "",
  eventTypeOverride?: BlacklistEventType,
): BlacklistRow | null {
  const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
  if (!eventDef) return null;
  const resolvedEventType = eventTypeOverride ?? eventDef.eventType;
  // ...
  return {
    // ...
    event_type: resolvedEventType,
    // ...
  };
}
```

The type import for `BlacklistEventType` is already present — it's used by `BlacklistEventDef` elsewhere in `blacklist-contracts.ts`. If not imported into `evm-source.ts` yet, add:

```ts
import type { BlacklistEventType } from "@shared/types/market";
```

- [ ] **Step 7b: Update the two `buildBlacklistRow` call sites**

There are two call sites in `parseEvmLogs`:

1. **Array-data branch** (around line 146): `addressArrayData` path that expands `address[]` events. TUSD does NOT use this path, so pass `undefined` (or simply omit the override — the default `?? eventDef.eventType` kicks in):

```ts
      if (eventDef.addressArrayData) {
        const addresses = decodeAddressArrayData(log.data);
        addresses.forEach((affectedAddress, index) => {
          const row = buildBlacklistRow(config, log, affectedAddress, null, blockNumber, timestamp, `-${index}`);
          if (row) rows.push(row);
        });
        continue;
      }
```

No change needed — the default parameter value handles it.

2. **Normal branch** (around line 173): this is where TUSD logs flow. Pass `effectiveEventType` as the 8th argument:

```ts
    const row = buildBlacklistRow(
      config,
      log,
      affectedAddress,
      amount,
      blockNumber,
      timestamp,
      "", // rowSuffix
      effectiveEventType,
    );
    if (row) rows.push(row);
```

The non-TUSD families still default to `eventDef.eventType` because they don't declare `eventTypeFromBoolSlot`, so `effectiveEventType` is identical to `eventDef.eventType` for them.

- [ ] **Step 8: Re-run tests + worker tsc**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add worker/src/lib/blacklist-contracts.ts worker/src/cron/blacklist/evm-source.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts shared/types/market.ts shared/data/stablecoins/usd-minor.json
git commit -m "$(cat <<'EOM'
blacklist: add TUSD coverage with bool-param event decoder

TUSD emits Blacklisted(address indexed, bool) where the same topic hash
covers both blacklist and unblacklist actions — the bool data slot
distinguishes them. Extend BlacklistEventDef with an optional
eventTypeFromBoolSlot hint and teach parseEvmLogs to derive the effective
event type from the slot. Reuses the existing destroy family via the
shared DestroyedBlackFunds topic.

Adds TUSD Ethereum config and promotes TUSD into BLACKLIST_STABLECOINS.

Fixes Agent B finding P1 (TUSD).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 4.7: Methodology version bump + docs

**Files:**
- Modify: `shared/lib/blacklist-tracker-version.ts` — new v3.91 entry
- Modify: `docs/blacklist-tracker.md` — update sync-coverage list and counts
- Modify: `docs/methodology/blacklist-tracker-changelog.mdx` (or equivalent changelog file — check existing path)
- Modify: `docs/blacklist-tracker-timeline.md` — append new wave

**Parallel-safe:** no (depends on the final state of the tracker after 4.1–4.6)
**Blocked by:** 4.6
**Commit:** C14

- [ ] **Step 1: Determine the correct next version**

`BLACKLIST_TRACKER_METHODOLOGY_VERSION` is currently `"3.9"`. Per the project methodology-version rule (`After v5.9, use v5.91 for a minor update`), this release is minor → **v3.91**. (Adjust if a subsequent wave lands between audit time and implementation time.)

- [ ] **Step 2: Add changelog entry**

In `shared/lib/blacklist-tracker-version.ts`, bump `currentVersion: "3.91"` and prepend a new entry:

```ts
  {
    version: "3.91",
    title: "Coverage expansion wave: wlfi-freeze destroys, new chains, USDP/TUSD",
    date: "2026-04-16",
    effectiveAt: <Math.floor(Date.UTC(2026, 3, 16, 0, 0, 0) / 1000)>,
    summary:
      "Extends the wlfi-freeze family with FrozenAccountDrained/FrozenFundsReallocated destroy events (USD1/U/FDUSD/EURI), adds native Circle USDC coverage on Linea/Sonic/Unichain/Worldchain/Celo, USDT0 Token coverage on LayerZero rollout chains, USDP Paxos on Ethereum, EURC on Worldchain, and TUSD Ethereum via a new bool-param event decoder.",
    impact: [
      "Added FrozenAccountDrained + FrozenFundsReallocated destroy tracking for USD1/U/FDUSD/EURI",
      "Added USDC FiatTokenV2 coverage on Linea, Sonic, Unichain, Worldchain, Celo",
      "Added USDT0 Token coverage on up to 11 LayerZero chains",
      "Added USDP (Pax Dollar) Ethereum coverage via Paxos freeze family",
      "Added EURC Worldchain coverage via Circle family",
      "Added TUSD Ethereum coverage with bool-param event decoder",
    ],
    commits: [],
    reconstructed: false,
  },
```

Replace the `<…>` placeholder with a Unix timestamp strictly greater than v3.9's (`1776211200` = 2026-04-15T00:00:00Z). The new v3.91 must sort after v3.9 by `effectiveAt`. Compute the intended ship date's midnight:

```bash
# 2026-04-16T00:00:00Z — if Phase 4 ships the day of the audit
node -e 'console.log(Math.floor(Date.UTC(2026,3,16,0,0,0)/1000))'
# → 1776297600
# (JS months are 0-indexed; April = 3.)

# 2026-04-17T00:00:00Z — if Phase 4 ships the day after the audit
node -e 'console.log(Math.floor(Date.UTC(2026,3,17,0,0,0)/1000))'
# → 1776384000
```

Pick whichever matches the real ship date, and use a matching comment:

```ts
    effectiveAt: 1776297600, // 2026-04-16T00:00:00Z — Phase 4 ships
```

(Or `1776384000, // 2026-04-17T00:00:00Z` if the PR lands the next day.) Do **NOT** reuse `1776211200` — it collides with v3.8/v3.9 and the tiebreak fix from Task 1.1 only guarantees deterministic ordering between those two.

- [ ] **Step 3: Update `docs/blacklist-tracker.md`**

Find the "Cron-backed sync coverage" line and add `USDP`, `TUSD`. Update the "53 contract configurations on 9 chains" claim to reflect the new count. Update the "Live API/UI filter enum" line similarly. Add new rows to the per-contract tables for each new (symbol × chain) pair, referencing the Task 4.1–4.6 deploy blocks.

Use:

```bash
grep -n "53 contract configurations" docs/blacklist-tracker.md
grep -n "Cron-backed sync coverage" docs/blacklist-tracker.md
grep -n "Live API/UI filter enum" docs/blacklist-tracker.md
```

- [ ] **Step 4: Update `docs/blacklist-tracker-timeline.md`**

Append a new wave entry matching the same format used by previous waves.

- [ ] **Step 5: Run every consumer test**

```bash
npx vitest run shared/lib/__tests__
cd worker && npx vitest run src/api/__tests__/blacklist.test.ts src/api/__tests__/blacklist-summary.test.ts
cd worker && npx tsc --noEmit
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add shared/lib/blacklist-tracker-version.ts docs/blacklist-tracker.md docs/blacklist-tracker-timeline.md
git commit -m "$(cat <<'EOM'
blacklist: bump tracker methodology to v3.91 for coverage wave

New changelog entry documents:
- wlfi-freeze destroy events (USD1/U/FDUSD/EURI)
- USDC on Linea/Sonic/Unichain/Worldchain/Celo
- USDT0 Token on LayerZero rollout chains (Ink/Berachain/Mantle/Sei/
  HyperEVM/Unichain/Monad/Flare/Plasma/XLayer/Corn)
- USDP Paxos Ethereum
- EURC Worldchain
- TUSD Ethereum with bool-param decoder

Also updates docs/blacklist-tracker.md counts and API filter enum
list to match the current CONTRACT_CONFIG_SPECS size.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 4 completion gate:** `npm run test:merge-gate` green, Etherscan smoke-tests non-zero for at least one config per new family, `/api/blacklist?stablecoin=USDP&limit=1` returns either a row or an empty array (not 400).

---

## Phase 5 — Amount Attribution

> **Phase goal:** convert ~11,500 currently-unattributed blacklist event rows into resolved or properly-provenanced amounts without introducing new external providers. Agent D's quantitative baseline (see `agents/audits/2026-04-16-blacklist-agent-d-amount-attribution.md`) is load-bearing for this phase.
>
> **Cohort counts (production snapshot, pre-Phase-5):**
> - Tron USDT NULL (blacklist + unblacklist): **7,109** rows, of which **6,921** have a matching `blacklist_current_balances` ledger row → win 1
> - Legacy `derived`/`amount_native=0` EVM blacklist/unblacklist/destroy: **4,381** rows, of which **952** are known-nonzero via ledger join → win 2
> - Legacy `derived`/`amount_native>0` rows: **3,970** → provenance re-label only, not new attribution
> - 11 PAXG/USDT destroy rows at `derived=0` → automatically swept by win 2

### Task 5.1: Introduce `current_balance_snapshot` amount_source + provenance types

**Files:**
- Modify: `shared/types/market.ts` — extend `BlacklistAmountSource` union
- Modify: `worker/src/api/__tests__/helpers/fixtures.ts` — update shared test fixture
- Test: `shared/lib/__tests__/blacklist.test.ts` if any shared helper uses the union

**Parallel-safe:** gate for the rest of Phase 5 (5.2–5.5 depend on it)
**Blocked by:** Phase 4 complete
**Commit:** part of C15

- [ ] **Step 1: Locate the union**

```bash
grep -n "amount_source\|BlacklistAmountSource\|amountSource" shared/types/market.ts shared/lib/blacklist.ts worker/src/api/__tests__/helpers/fixtures.ts worker/src/lib/blacklist-api.ts
```

- [ ] **Step 2: Extend the TypeScript type union**

In `shared/types/market.ts`, find the `BlacklistAmountSource` type and add the new values:

```ts
export type BlacklistAmountSource =
  | "event"
  | "historical_balance"
  | "derived"
  | "unavailable"
  | "current_balance_snapshot"
  | "legacy_migration";
```

(`legacy_migration` is used by Task 5.6 for the re-label pass; declare both here so 5.5 and 5.6 don't each bump the type.)

- [ ] **Step 2b: Extend the zod enum (CRITICAL — or frontend breaks)**

The same file exports `BlacklistEventSchema` whose `amountSource` field is a strict `z.enum([...])`. The frontend runs `BlacklistResponseSchema.safeParse(...)` in strict mode (`src/lib/api.ts`). Any new `amount_source` value served by the worker that is not in this enum will throw `SchemaValidationError` and break the `/blacklist` page.

Find the enum declaration at `shared/types/market.ts` (search for `amountSource: z.enum(`) and replace with:

```ts
  amountSource: z.enum([
    "event",
    "historical_balance",
    "derived",
    "unavailable",
    "current_balance_snapshot",
    "legacy_migration",
  ]),
```

- [ ] **Step 2c: Update the shared test fixture**

`worker/src/api/__tests__/helpers/fixtures.ts` currently declares its own inline string-literal union at line 19 (`amount_source: "event" | "historical_balance" | "derived" | "unavailable"`). Replace it with a type import so the fixture tracks `shared/types/market.ts`:

```ts
import type { BlacklistAmountSource, BlacklistAmountStatus } from "@shared/types/market";
```

Then change the local `amount_source` + `amount_status` field types on the fixture factory's input type to use `BlacklistAmountSource` / `BlacklistAmountStatus` directly. Verify the factory's default values remain compatible (`"event"`, `"resolved"`, etc. — all in the union).

- [ ] **Step 3: Update `BlacklistAmountStatus` if needed**

The Tron ledger-mirror rows will use `amount_status = "resolved"` with `amount_source = "current_balance_snapshot"` — the status union does not need a new value. No change required for `BlacklistAmountStatus` here; the row semantics are expressed entirely via `amount_source`.

- [ ] **Step 4: Type-check both the worker and the frontend**

```bash
cd worker && npx tsc --noEmit && cd ..
npx tsc --noEmit
```

Both must be clean. If either surfaces a string-literal assignment that no longer narrows, fix at the call site — do NOT widen the union back.

- [ ] **Step 5: Stage for commit (no individual commit)**

This is grouped into C15 with 5.2 and 5.3. The explicit commit block is at the end of Task 5.3.

---

### Task 5.2: Tron ledger-join backfill function

**Files:**
- Modify: `worker/src/cron/blacklist/amount-recovery.ts` — new `backfillTronFromLedger(db)` exported function + integration with `backfillAmounts` schedule
- Modify: `worker/src/cron/sync-blacklist.ts` — invoke the ledger-join before `backfillAmounts`
- Test: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts`

**Parallel-safe:** no (shares amount-recovery.ts with 5.3/5.4)
**Blocked by:** 5.1
**Commit:** part of C15

- [ ] **Step 1: Write the failing test (use an in-memory D1 stub or better-sqlite3)**

Add a new test block to `amount-recovery.test.ts` that:
1. Seeds two rows in `blacklist_events`: one Tron USDT blacklist with `amount_native = null, amount_status = 'permanently_unavailable'`, one without a matching ledger entry.
2. Seeds `blacklist_current_balances` with only the first address (nonzero amount).
3. Calls `backfillTronFromLedger(db)`.
4. Asserts the first row is updated to `amount_native = <ledger value>, amount_source = 'current_balance_snapshot', amount_status = 'resolved'`.
5. Asserts the second row is untouched.

If the repo has an existing D1 test helper (check `worker/src/__tests__/helpers/*` or similar), use it. Otherwise use a minimal mock that implements `.prepare().bind().all()` and `.batch()`.

- [ ] **Step 2: Run and confirm FAIL**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts -t "backfillTronFromLedger"
```

- [ ] **Step 3: Implement `backfillTronFromLedger`**

Add to `worker/src/cron/blacklist/amount-recovery.ts`:

```ts
/**
 * Cross-populate Tron blacklist/unblacklist rows with the matching
 * freeze-ledger snapshot from `blacklist_current_balances`. These rows
 * were stamped `permanently_unavailable` at ingest because Tron has no
 * cheap historical balanceOf path, but Pharos already holds a snapshot
 * value (from kyc.rip bootstrap or ongoing current-balance sync) that
 * we can mirror back with `amount_source = 'current_balance_snapshot'`
 * for honest provenance.
 *
 * Zero subrequest cost: pure D1.
 */
export async function backfillTronFromLedger(
  db: D1Database,
): Promise<{ updated: number }> {
  const result = await db
    .prepare(
      `UPDATE blacklist_events
       SET amount_native = (
             SELECT bcb.amount_native
             FROM blacklist_current_balances bcb
             WHERE bcb.stablecoin = blacklist_events.stablecoin
               AND bcb.chain_id = blacklist_events.chain_id
               AND LOWER(bcb.address) = LOWER(blacklist_events.address)
               AND bcb.amount_native IS NOT NULL
             LIMIT 1
           ),
           amount_usd_at_event = (
             SELECT bcb.amount_usd
             FROM blacklist_current_balances bcb
             WHERE bcb.stablecoin = blacklist_events.stablecoin
               AND bcb.chain_id = blacklist_events.chain_id
               AND LOWER(bcb.address) = LOWER(blacklist_events.address)
               AND bcb.amount_native IS NOT NULL
             LIMIT 1
           ),
           amount_source = 'current_balance_snapshot',
           amount_status = 'resolved',
           amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
           amount_last_attempted_at = ?,
           amount_last_error_class = NULL,
           amount_last_provider = 'current_balances_ledger'
       WHERE chain_id = 'tron'
         AND amount_native IS NULL
         AND suppression_reason IS NULL
         AND event_type IN ('blacklist', 'unblacklist')
         AND EXISTS (
           SELECT 1
           FROM blacklist_current_balances bcb
           WHERE bcb.stablecoin = blacklist_events.stablecoin
             AND bcb.chain_id = blacklist_events.chain_id
             AND LOWER(bcb.address) = LOWER(blacklist_events.address)
             AND bcb.amount_native IS NOT NULL
         )`,
    )
    .bind(Math.floor(Date.now() / 1000))
    .run();

  return { updated: result.meta.changes ?? 0 };
}
```

- [ ] **Step 4: Invoke from `syncBlacklist`**

In `worker/src/cron/sync-blacklist.ts`, immediately before the `backfillAmounts(...)` call:

```ts
  // Tron rows cannot be amount-resolved via historical balanceOf, but
  // the freeze ledger from kyc.rip + ongoing snapshot sync holds
  // current-balance values we can mirror back for provenance-aware
  // display. Runs before backfillAmounts because it is pure SQL and
  // drains a much larger cohort in a single operation.
  let tronLedgerUpdated = 0;
  try {
    const ledgerResult = await backfillTronFromLedger(db);
    tronLedgerUpdated = ledgerResult.updated;
    if (tronLedgerUpdated > 0) {
      console.log(`[sync-blacklist] Tron ledger mirror updated ${tronLedgerUpdated} row(s)`);
    }
  } catch (err) {
    console.warn("[sync-blacklist] Tron ledger mirror failed:", err);
  }
```

And add `tronLedgerUpdated` to the metadata JSON at the bottom of the function.

Import `backfillTronFromLedger` at the top.

- [ ] **Step 5: Re-run the test, confirm PASS**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts -t "backfillTronFromLedger"
```

- [ ] **Step 6: Run the sync-blacklist test**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-blacklist.test.ts
```

---

### Task 5.3: Stop stamping new Tron blacklist events `permanently_unavailable`

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts` — new row `amount_status`
- Modify: `worker/src/cron/blacklist/amount-recovery.ts` — `enrichRowBalances` Tron branch
- Test: `worker/src/cron/blacklist/__tests__/tron-source.test.ts` (may not exist yet — see Task 7.1) — add a minimal case here

**Parallel-safe:** yes (within Phase 5, with coordination on amount-recovery.ts)
**Blocked by:** 5.1, 5.2 (so new rows flow into the ledger-mirror pool)
**Commit:** part of C15

- [ ] **Step 1: Modify the new-row defaults in `parseTronEvent`**

Currently `tron-source.ts:73-78` sets `amount_status = "permanently_unavailable"` for Tron blacklist/unblacklist when no amount is present. Change to:

```ts
    amount_status: amount != null ? "resolved" : "recoverable_pending",
```

The previous `permanently_unavailable` default prevented those rows from ever re-entering backfill. After this change, new Tron blacklist/unblacklist rows sit in `recoverable_pending` until `backfillTronFromLedger` (Task 5.2) mirrors the current-balance snapshot into them on the next cron cycle.

- [ ] **Step 2: Remove the Tron early-skip in `enrichRowBalances`**

In `amount-recovery.ts:117-125`, the existing Tron branch stamps `permanently_unavailable` when `event_type !== "destroy"`. Replace with a comment:

```ts
    if (config.chain.type === "tron") {
      // Tron blacklist/unblacklist rows cannot be resolved via historical
      // balanceOf. They will be picked up by backfillTronFromLedger on the
      // next cron cycle and mirrored from the freeze-ledger snapshot.
      // We no longer early-stamp permanently_unavailable here; the
      // ledger mirror is the authoritative path.
      if (row.event_type !== "destroy") continue;
      // Destroy events keep their native amount from the event payload
      // (handled above by the `row.amount_native != null` check). Nothing
      // else to do here on Tron.
      continue;
    } else if (config.chain.evmChainId != null) {
```

- [ ] **Step 3: Update the existing single enrichment test to match**

Find the test in `amount-recovery.test.ts` that asserts `amount_status === "permanently_unavailable"` for a Tron blacklist row and update it to assert `amount_status === "recoverable_pending"` instead. Add a new assertion that the ledger-mirror call would subsequently resolve the row.

- [ ] **Step 4: Run tests + type-check**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit C15 (grouped 5.1 + 5.2 + 5.3)**

This is the commit boundary for Tasks 5.1, 5.2, and 5.3 together. Stage every file touched by the three tasks:

```bash
git add \
  shared/types/market.ts \
  worker/src/api/__tests__/helpers/fixtures.ts \
  worker/src/cron/blacklist/amount-recovery.ts \
  worker/src/cron/blacklist/tron-source.ts \
  worker/src/cron/sync-blacklist.ts \
  worker/src/cron/blacklist/__tests__/amount-recovery.test.ts
git status
```

Confirm exactly the above files are staged. If Task 5.1 touched any other file (e.g., `shared/lib/blacklist.ts` consumers surfaced by the type tightening), add it now.

```bash
git commit -m "$(cat <<'EOM'
blacklist: introduce current_balance_snapshot amount source and Tron ledger mirror

Extend the BlacklistAmountSource union (and the sibling zod enum) to
include current_balance_snapshot and legacy_migration, so amounts can
be mirrored from the blacklist_current_balances freeze ledger with
honest provenance. Add backfillTronFromLedger(db) — a pure-SQL pass
that cross-populates 6,921 Tron USDT blacklist/unblacklist rows from
the kyc.rip bootstrap without any new external calls. Stop stamping
new Tron rows permanently_unavailable at ingest so they enter the
recoverable pool.

Related test fixture widened to use the shared unions so future
amount_source additions don't require a second edit.

Fixes Agent D Critical 2 and High 3.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 5.4: Widen `backfillAmounts` WHERE clause for legacy derived zero rows

**Files:**
- Modify: `worker/src/cron/blacklist/amount-recovery.ts` — `backfillAmounts` SQL + success path
- Test: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts` — new regression

**Parallel-safe:** no (same file)
**Blocked by:** 5.3
**Commit:** C16

- [ ] **Step 1: Read the current query**

```bash
sed -n '265,295p' worker/src/cron/blacklist/amount-recovery.ts
```

- [ ] **Step 2: Write the failing test**

Add a test case that seeds a row with `amount_source = 'derived', amount_native = 0, amount_status = 'resolved', chain_id = 'ethereum', event_type = 'blacklist'`, stubs `fetchEvmTokenBalance` to return `1500`, calls `backfillAmounts`, and asserts the row is updated to `amount_native = 1500, amount_source = 'historical_balance', amount_status = 'resolved'`.

- [ ] **Step 3: Confirm it FAILS**

(The current WHERE clause filters on `amount_status IN ('recoverable_pending','provider_failed','ambiguous')` so the derived-zero row is never picked up.)

- [ ] **Step 4: Update the SELECT query (widen WHERE + add amount_source to the projection)**

The existing SELECT projects 13 columns. Add `amount_source` to the projection so the failure-path guard in Step 6 can branch on the row's prior provenance without a second query.

```ts
  const result = await db
    .prepare(
      `SELECT id, chain_id, event_type, address, block_number, stablecoin, tx_hash, config_key, contract_address,
              amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider,
              amount_source
       FROM blacklist_events
       WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
         AND (
               amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
               OR (
                 amount_source = 'derived'
                 AND amount_native = 0
                 AND amount_status = 'resolved'
                 AND chain_id != 'tron'
               )
             )
       ORDER BY
         -- Prefer provider_failed/recoverable_pending first, then the
         -- oldest legacy derived-zero rows so the backlog drains
         -- predictably without churning the fresh-event queue.
         CASE
           WHEN amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous') THEN 0
           ELSE 1
         END ASC,
         timestamp DESC
       LIMIT ?`,
    )
    .bind(BACKFILL_BATCH_SIZE)
    .all<{
      id: string;
      chain_id: string;
      event_type: string;
      address: string;
      block_number: number;
      stablecoin: string;
      tx_hash: string;
      config_key: string | null;
      contract_address: string | null;
      amount_attempt_count: number | null;
      amount_last_attempted_at: number | null;
      amount_last_error_class: string | null;
      amount_last_provider: string | null;
      amount_source: string;
    }>();
```

- [ ] **Step 5: In the success path, promote `amount_source` to `historical_balance`**

The existing SQL at the end of the success branch already sets `amount_source = ?` from the `amountSource` local. For the `derived`/`0` cohort that local resolves to `"historical_balance"` via the existing EVM branch — no code change needed for the happy path. Verify by tracing: success path sets `amountSource = "historical_balance"` when `fetchEvmTokenBalance` returns a value (including `0`). Rows previously tagged `derived`/`0` are thus correctly re-provenanced on successful refresh.

- [ ] **Step 6: Guard the failure-path demote**

Replace the existing null-amount `else` branch so that rows previously holding `amount_source = 'derived'` with `amount_native = 0` stay in `resolved` state when the refresh returns null (we'll retry via the `OR` branch next cycle; demoting to `provider_failed` would churn the status back and forth).

Locate the failure `else` block (currently around lines 445-463 of `amount-recovery.ts` — the branch beginning `} else {` that runs when `amount == null`). Replace it with:

```ts
    } else {
      // If the refresh on a legacy derived-zero row returned null, keep
      // the row `resolved` so it doesn't thrash between resolved and
      // provider_failed on every cron cycle. The widened WHERE clause
      // will pick it up again next run via the `OR amount_source='derived'`
      // branch until a successful refresh lands.
      const wasLegacyDerived = row.amount_source === "derived";

      if (wasLegacyDerived) {
        stmts.push(
          db.prepare(
            `UPDATE blacklist_events
             SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
                 amount_last_attempted_at = ?,
                 amount_last_error_class = ?,
                 amount_last_provider = ?
             WHERE id = ?`,
          ).bind(
            attemptAt,
            lastErrorClass,
            lastProvider,
            row.id,
          ),
        );
      } else {
        stmts.push(
          db.prepare(
            `UPDATE blacklist_events
             SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
                 amount_last_attempted_at = ?,
                 amount_last_error_class = ?,
                 amount_last_provider = ?,
                 amount_status = ?
             WHERE id = ?`,
          ).bind(
            attemptAt,
            lastErrorClass,
            lastProvider,
            amountStatus,
            row.id,
          ),
        );
      }
    }
```

The `wasLegacyDerived` branch skips `amount_status = ?` so the row stays `resolved`. The non-legacy branch behaves exactly as today. Both branches still bump `amount_attempt_count` for observability.

- [ ] **Step 7: Re-run the test, confirm PASS**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts
```

- [ ] **Step 8: Worker type-check + full blacklist tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/blacklist src/lib/__tests__/blacklist-contracts.test.ts
```

- [ ] **Step 9: Commit (this is one commit ahead of the grouped C15 above)**

```bash
git add worker/src/cron/blacklist/amount-recovery.ts worker/src/cron/blacklist/__tests__/amount-recovery.test.ts
git commit -m "$(cat <<'EOM'
blacklist: recover legacy derived-zero rows in backfillAmounts

Migration 0076 bulk-promoted the old `amount` column into `amount_native`
and stamped every row `resolved`, then marked the source `derived`. That
bulk update silently excluded 4,381 EVM blacklist/unblacklist/destroy
rows (952 of which are provably nonzero in blacklist_current_balances)
from the active backfill pool.

Widen the backfill WHERE clause to include
(amount_source='derived' AND amount_native=0 AND amount_status='resolved'
 AND chain_id != 'tron')
and promote the provenance to historical_balance on successful refresh.

Expected to resurface up to 4,381 previously-missing amount values over
~4 days of hourly cron cycles.

Fixes Agent D Critical 1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 5.5: Frontend provenance badge for snapshot amounts

**Files:**
- Modify: `worker/src/lib/blacklist-api.ts` — emit the provenance on the wire type
- Modify: `shared/types/market.ts` — wire type must expose `amountSource`
- Modify: `src/components/blacklist-table.tsx` — render badge next to the amount cell
- Test: `src/components/__tests__/blacklist-table.test.ts` (new or extended)

**Parallel-safe:** yes (different files from 5.2/5.3/5.4)
**Blocked by:** 5.1 (type union), 5.2 (provenance exists in DB)
**Commit:** C17

- [ ] **Step 1: Confirm `amountSource` is already on the wire type**

```bash
grep -n "amountSource\|amount_source" worker/src/lib/blacklist-api.ts shared/types/market.ts
```

If missing, add it to `BlacklistEvent` in `shared/types/market.ts` and make sure `mapBlacklistEventRow` passes it through.

- [ ] **Step 2: Write failing UI test**

```tsx
  it("renders a Snapshot badge when amountSource is current_balance_snapshot", () => {
    const { getByText } = render(
      <BlacklistTable
        events={[
          {
            id: "tron-abc-0",
            stablecoin: "USDT",
            chainId: "tron",
            chainName: "Tron",
            eventType: "blacklist",
            address: "0xaa",
            amountNative: 12_345,
            amountUsdAtEvent: 12_345,
            amountSource: "current_balance_snapshot",
            amountStatus: "resolved",
            txHash: "0xabc",
            blockNumber: 100,
            timestamp: 1_700_000_000,
            contractAddress: "Tx…",
            configKey: "tron-x",
            eventSignature: "AddedBlackList(address)",
            eventTopic0: null,
            explorerTxUrl: "https://tronscan.org/#/tx/abc",
            explorerAddressUrl: "https://tronscan.org/#/address/xyz",
          },
        ] as const}
        isLoading={false}
        page={1}
        pageSize={50}
        sortKey="date"
        sortDirection="desc"
        onSortChange={() => {}}
      />,
    );
    expect(getByText(/Snapshot/i)).toBeInTheDocument();
  });
```

- [ ] **Step 3: Confirm FAIL**

```bash
npx vitest run src/components/__tests__/blacklist-table.test.ts -t "Snapshot badge"
```

- [ ] **Step 4: Implement the badge**

In `src/components/blacklist-table.tsx`, where the amount cell is rendered, add a small badge adjacent to the numeric display when `evt.amountSource === "current_balance_snapshot"`:

```tsx
{evt.amountSource === "current_balance_snapshot" ? (
  <span
    className="ml-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide border border-border text-muted-foreground"
    title="Amount is a freeze-ledger snapshot, not event-time precision"
  >
    Snapshot
  </span>
) : null}
```

Match existing `blacklist-table.tsx` styling conventions — use the tokens already imported by the file.

- [ ] **Step 5: Re-run test, confirm PASS**

- [ ] **Step 6: Run full frontend tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/blacklist-api.ts shared/types/market.ts src/components/blacklist-table.tsx src/components/__tests__/blacklist-table.test.ts
git commit -m "$(cat <<'EOM'
blacklist: provenance badge for snapshot-sourced amounts on table

Amounts recovered via the Tron freeze-ledger mirror carry
amount_source='current_balance_snapshot' to preserve honest provenance
over event-time precision. Render an inline "Snapshot" badge next to
such values so users can distinguish a mirrored proxy from a verified
historical balance.

Refs Agent D Critical 2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 5.6: Methodology documentation for attribution tiers

**Files:**
- Modify: `docs/blacklist-tracker.md` — new subsection under "Amount Semantics"
- Modify: `src/app/methodology/blacklist-tracker-changelog/*` (pick up the correct changelog path — grep for "BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH" consumers)
- Modify: `shared/lib/blacklist-tracker-version.ts` — bump to v3.92 for the attribution wave

**Parallel-safe:** yes (docs-only)
**Blocked by:** 5.5
**Commit:** C18

- [ ] **Step 1: Add "Amount Provenance Tiers" section**

Append to `docs/blacklist-tracker.md` under the existing "Amount semantics" list:

```md
### Amount provenance tiers (v3.92+)

- `event` — decoded from the emitting log's amount field. Highest precision.
- `historical_balance` — `balanceOf(address)` at `blockNumber - 1` via dRPC / chain RPC / Etherscan fallback. High confidence.
- `current_balance_snapshot` — mirrored from `blacklist_current_balances`, reflecting the address's current freeze-ledger value rather than event-time balance. Used for Tron USDT blacklist/unblacklist rows where historical balance is unavailable. The `/blacklist` UI renders a **Snapshot** badge next to these values.
- `legacy_migration` — value promoted from the pre-v3.2 `amount` DB column during migration 0076. Kept for archival continuity; do not treat as authoritative.
- `unavailable` — no amount could be attributed and none is expected (e.g., non-destroy Tron rows that also lack a ledger match).
```

- [ ] **Step 2: Bump methodology to v3.92**

Same pattern as Task 4.7, but with `version: "3.92"`, dated 2026-04-17 (or the real date when Phase 5 ships). Use an `effectiveAt` that is strictly greater than v3.91's.

- [ ] **Step 3: Commit**

```bash
git add docs/blacklist-tracker.md shared/lib/blacklist-tracker-version.ts
git commit -m "$(cat <<'EOM'
docs: document amount provenance tiers in blacklist methodology

Adds a Tier list to docs/blacklist-tracker.md explaining
current_balance_snapshot, legacy_migration, and the full provenance
ladder used by the backfill pipeline. Bumps methodology to v3.92.

Refs Agent D Critical 2 + 1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 5 completion gate:** after one hourly sync cycle post-deploy, the following SQL should show:

```sql
SELECT amount_source, amount_status, COUNT(*) AS cnt
FROM blacklist_events
WHERE suppression_reason IS NULL
GROUP BY amount_source, amount_status
ORDER BY cnt DESC;
```

Expected changes vs. pre-Phase-5 baseline:
- `current_balance_snapshot` / `resolved` — ~6,921 new rows
- `derived` / `resolved` — drops below 4,381 as the backfill drains
- `historical_balance` / `resolved` — grows accordingly

---

## Phase 6 — Code Quality

> **Phase goal:** apply the non-speculative Agent C items. Within this phase, Lane A (6.1) must run before Lanes B/C/D so the type tightening doesn't race other changes. Lanes B, C, D are parallel-safe.

### Task 6.1: `BlacklistRow` type drift (nullable + enum unions)

**Files:**
- Modify: `worker/src/cron/blacklist/shared.ts` — type declarations
- Modify: `worker/src/cron/blacklist/evm-source.ts`, `tron-source.ts`, `persistence.ts`, `amount-recovery.ts`, `post-fetch.ts`, `current-balance-cache.ts` — pick up any TS errors surfaced by the tightening

**Parallel-safe:** no (all other Phase 6 tasks depend on this landing first)
**Blocked by:** Phase 5 complete
**Commit:** C19

- [ ] **Step 1: Import the precise unions in `shared.ts`**

```ts
import type {
  BlacklistEventType,
  BlacklistAmountSource,
  BlacklistAmountStatus,
} from "@shared/types/market";
```

(Or via a relative path if the `@shared/*` alias is not configured for `worker/` — check `worker/tsconfig.json`. If the alias does not work inside the worker folder, use the relative `../../../../shared/types/market`.)

- [ ] **Step 2: Replace the drift-prone fields**

```ts
export interface BlacklistRow {
  id: string;
  stablecoin: BlacklistStablecoin; // was string
  chain_id: string;
  chain_name: string;
  event_type: BlacklistEventType;
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: BlacklistAmountSource;
  amount_status: BlacklistAmountStatus;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  suppression_reason?: string | null;
  amount_attempt_count: number | null; // was number — legacy rows can be NULL
  amount_last_attempted_at: number | null;
  amount_last_error_class: string | null;
  amount_last_provider: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
}
```

Also import `BlacklistStablecoin` alongside the other unions.

- [ ] **Step 3: Worker tsc — surface all type errors produced by the tightening**

```bash
cd worker && npx tsc --noEmit 2>&1 | head -80
```

Expected: errors pointing at string-literal assignments that don't narrow cleanly. For each error, either narrow the literal with `as const` or tighten the surrounding type. Do NOT widen the new union back to `string` — that defeats the fix.

- [ ] **Step 4: Fix the specific callers**

Known spots that will surface:
- `evm-source.ts:121` — `amount_attempt_count: 0` is compatible with `number | null`, no change needed.
- `tron-source.ts:88` — same.
- `amount-recovery.ts:288` — SELECT result type should already be `number | null`, no change needed.
- `current-balance-cache.ts` — if a local `const someStatus: string = …` is assigned to `row.amount_status`, either tighten the local or cast explicitly.

- [ ] **Step 5: Run worker tests**

```bash
cd worker && npx vitest run src/cron/blacklist src/lib/__tests__/blacklist-contracts.test.ts src/api/__tests__/blacklist.test.ts src/api/__tests__/blacklist-summary.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/blacklist/shared.ts worker/src/cron/blacklist worker/src/lib/blacklist-api.ts
git commit -m "$(cat <<'EOM'
blacklist: type BlacklistRow with precise unions

Replace untyped string fields (event_type, amount_source, amount_status,
stablecoin) with the precise unions from shared/types/market.ts, and
make amount_attempt_count nullable to match the DB schema. Prevents
silent enum drift between ingestion, persistence, enrichment, and the
wire type.

Fixes Agent C findings H4 and H5.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 6.2: Extract `decodeEvmLogAmount` helper

**Files:**
- Modify: `worker/src/cron/blacklist/evm-source.ts`
- Test: existing `__tests__/evm-source.test.ts` (must still pass as-is)

**Parallel-safe:** yes (Lane B — only task in this lane now that 6.3 is removed)
**Blocked by:** 6.1
**Commit:** C20

- [ ] **Step 1: Add the helper above `parseEvmLogs`**

```ts
function decodeEvmLogAmount(
  eventDef: BlacklistEventDef,
  log: EvmLogLike,
  decimals: number,
  addressFromTopic: boolean,
): number | null {
  if (!eventDef.hasAmount) return null;

  if (typeof eventDef.amountTopicIndex === "number" && log.topics.length > eventDef.amountTopicIndex) {
    return decodeUint256(log.topics[eventDef.amountTopicIndex]!, decimals);
  }
  if (typeof eventDef.amountDataIndex === "number") {
    return decodeUint256AtSlot(log.data, eventDef.amountDataIndex, decimals);
  }
  // Legacy fallthrough: address-indexed means data starts with the amount;
  // non-indexed address means data starts with the address and the amount
  // follows the first 32-byte slot.
  if (addressFromTopic) {
    return log.data.length >= 66 ? decodeUint256(log.data, decimals) : null;
  }
  return log.data.length > 66 ? decodeUint256("0x" + log.data.slice(66), decimals) : null;
}
```

- [ ] **Step 2: Replace the inline ternary in `parseEvmLogs`**

```ts
    const amount = decodeEvmLogAmount(eventDef, log, config.decimals, addressFromTopic);
```

- [ ] **Step 3: Run the full evm-source test suite**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
```

Expected: all pass — this is a pure extraction, behaviour is identical.

- [ ] **Step 4: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Commit C20**

```bash
git add worker/src/cron/blacklist/evm-source.ts
git commit -m "$(cat <<'EOM'
blacklist: extract decodeEvmLogAmount helper

Replace the 5-branch nested ternary in parseEvmLogs with a named
decodeEvmLogAmount(eventDef, log, decimals, addressFromTopic) helper.
Pure extraction — no behaviour change. Reduces maintenance risk and
makes the branch semantics grep-able.

Fixes Agent C finding H2. Finding H1 ("duplicated counter merge") was
already resolved before this audit in
worker/src/cron/blacklist/post-fetch-counters.ts.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 6.3: [REMOVED — stale finding; see Task 6.2 Step 5 for the C20 commit]

Agent C finding H1 ("duplicated counter merge in `sync-blacklist.ts`") was already resolved before this audit. `worker/src/cron/blacklist/post-fetch-counters.ts` encapsulates the merge via `processRowsAndAccumulatePostFetchRows(context, counters)`, and both call sites in `sync-blacklist.ts` (tron branch line 203, evm branch line 265) use it today. Task 6.3 has been removed from this plan; Lane B contains only Task 6.2 (decodeEvmLogAmount extraction). The C20 commit is defined in Task 6.2 Step 5 — do not produce a second commit for C20.

---

### Task 6.4: Rename Hex Trust topic constants

**Files:**
- Modify: `worker/src/lib/blacklist-contracts.ts`

**Parallel-safe:** yes (Lane C)
**Blocked by:** Phase 4 complete (so the new wave's specs use the renamed constants)
**Commit:** C21

- [ ] **Step 1: Rename the two constants**

```ts
const HEX_TRUST_ADDED_BLACKLIST_TOPIC = "0x86c048150dfc5def3c35f7bc81582956dd964e56d8c028c9f4f5e978bb203c31"; // AddedBlacklist(address)
const HEX_TRUST_REMOVED_BLACKLIST_TOPIC = "0x90792cb7177eb70be35a14e39400d4143370da97f528237fd2b069e408ca68fb"; // RemovedBlacklist(address)
```

- [ ] **Step 2: Update the consuming family**

```ts
const ADDED_REMOVED_BLACKLIST_EVENT_FAMILY = defineEventFamily("added-removed-blacklist", [
  { signature: "AddedBlacklist(address)", topicHash: HEX_TRUST_ADDED_BLACKLIST_TOPIC, eventType: "blacklist", hasAmount: false },
  { signature: "RemovedBlacklist(address)", topicHash: HEX_TRUST_REMOVED_BLACKLIST_TOPIC, eventType: "unblacklist", hasAmount: false },
]);
```

- [ ] **Step 3: Type-check + run tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts
```

---

### Task 6.5: Add legacy column comment to `persistence.ts`

**Files:**
- Modify: `worker/src/cron/blacklist/persistence.ts`

**Parallel-safe:** yes (Lane C)
**Blocked by:** 6.1
**Commit:** C21

- [ ] **Step 1: Add the comment above the INSERT**

```ts
  // The DB has both `amount` and `amount_native` columns. `amount` is a
  // legacy column kept in lockstep with amount_native so pre-v3.2
  // dashboards continue to work. New writers should prefer amount_native
  // and let the COALESCE-based migration drop `amount` eventually.
```

---

### Task 6.6: Fix `inferErrorClass` ordering

**Files:**
- Modify: `worker/src/cron/blacklist/amount-recovery.ts:70-75`

**Parallel-safe:** yes (Lane C)
**Blocked by:** 5.4 (same file)
**Commit:** C21

- [ ] **Step 1: Flip the ordering and add a comment**

```ts
function inferErrorClass(error: unknown): BlacklistRecoveryErrorClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Order matters: an "HTTP 504 timeout" should classify as http_error
  // rather than bare provider_timeout, so check http before timeout.
  if (message.includes("http")) return "provider_http_error";
  if (message.includes("timeout")) return "provider_timeout";
  return "provider_null";
}
```

---

### Task 6.7: Rename `addressIndexed` → `addressFromTopic` in `evm-source.ts`

**Files:**
- Modify: `worker/src/cron/blacklist/evm-source.ts`

**Parallel-safe:** yes (Lane C)
**Blocked by:** 6.2 (same function scope)
**Commit:** C21

- [ ] **Step 1: Replace the variable name**

```ts
    // Inferred per-log: true when this log carries the affected address
    // in an indexed topic slot (not in the non-indexed data tail). Note
    // this is a per-log fact, not a per-event-def property — some
    // families can carry addresses in either location depending on
    // the explicit addressDataIndex override.
    const addressFromTopic = forcedDataAddress == null && log.topics.length > topicIdx;
```

Propagate the rename to the `decodeEvmLogAmount` call site (Task 6.2 already uses `addressFromTopic`).

---

### Task 6.8: Document `tronResultKey` fallback in `tron-source.ts`

**Files:**
- Modify: `worker/src/cron/blacklist/tron-source.ts:50-55`

**Parallel-safe:** yes (Lane C)
**Blocked by:** 5.3 (same file)
**Commit:** C21

- [ ] **Step 1: Add the comment**

```ts
    // Affected-address lookup fallback chain:
    //   1. `tronResultKey` — explicit per-event-def override (e.g., USD1 uses "account")
    //   2. `_user` — modern Tether Tron events
    //   3. `_blackListedUser` — legacy Tether Tron events
    //   4. `"0"` — TronGrid positional fallback for unnamed params
    const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
      || evt.result._user
      || evt.result._blackListedUser
      || evt.result["0"]
      || "";
```

---

### Task 6.9: Delete dead `blacklist-table-logic.ts` + test

**Files:**
- Delete: `src/components/blacklist-table-logic.ts`
- Delete: `src/components/__tests__/blacklist-table-logic.test.ts`
- Modify: any doc referencing it (`docs/agent-code-map.md`, `docs/architecture.md`)

**Parallel-safe:** yes (Lane D)
**Blocked by:** 6.1 (types must be stable before removing files)
**Commit:** C22

- [ ] **Step 1: Grep for callers**

```bash
grep -rn "blacklist-table-logic\|compareBlacklistRows" src docs tests 2>/dev/null | grep -v node_modules
```

The only expected hits are the file itself, its test, and docs entries.

- [ ] **Step 2: Delete the files**

```bash
rm src/components/blacklist-table-logic.ts src/components/__tests__/blacklist-table-logic.test.ts
```

- [ ] **Step 3: Scrub docs**

Update `docs/agent-code-map.md` and `docs/architecture.md` to remove any reference. If those docs also mention the symbol, remove the line entirely (don't leave a dangling "(removed)" — leave the commit message as the historical marker).

- [ ] **Step 4: Build + tests**

```bash
npm run build
npm test
```

---

### Task 6.10: Remove unused `setSearchInput` return

**Files:**
- Modify: `src/app/blacklist/view-model.ts` — drop `setSearchInput` from the return object

**Parallel-safe:** yes (Lane D)
**Blocked by:** none within Phase 6
**Commit:** C22

- [ ] **Step 1: Edit the return**

Remove the `setSearchInput,` line from the `return { … }` block. Keep the internal `useState` + setter declaration.

- [ ] **Step 2: Verify no consumer uses it**

```bash
grep -rn "setSearchInput" src/app/blacklist
```

Expected: only the internal declaration in the view-model remains.

- [ ] **Step 3: Build + tests**

```bash
npm run build
npm test -- --run src/app/blacklist
```

---

### Task 6.11: Extract `formatBlacklistAmountCell`

**Files:**
- Modify: `src/components/blacklist-table.tsx`
- Test: `src/components/__tests__/blacklist-table.test.ts` (or a new unit test of the pure helper)

**Parallel-safe:** yes (Lane D)
**Blocked by:** 5.5 (the provenance badge lives in the same cell)
**Commit:** C22

- [ ] **Step 1: Extract the helper**

At the top of `blacklist-table.tsx` (or a sibling helper file), add:

```ts
function formatBlacklistAmountCell(evt: BlacklistEvent): string {
  // Keep in sync with the CSV export logic in the same file.
  if (evt.amountNative == null) return "—";
  if (evt.amountNative === 0 && evt.eventType !== "destroy") return "—";
  // … existing USD/native branch logic
}
```

Replace the inline ternary in the render with a call to `formatBlacklistAmountCell(evt)` + the provenance-badge span (from Task 5.5).

- [ ] **Step 2: Also update the CSV export to reuse the helper**

The sibling code at lines 79-85 (CSV row builder) performs the same amount suppression check — update it to call the helper too, guaranteeing parity.

- [ ] **Step 3: Run the full frontend test suite**

```bash
npm test
```

- [ ] **Step 4: Commit (combined Lane D commit)**

```bash
git add src/components/blacklist-table.tsx src/components/__tests__ src/app/blacklist/view-model.ts docs
git rm src/components/blacklist-table-logic.ts src/components/__tests__/blacklist-table-logic.test.ts
git commit -m "$(cat <<'EOM'
blacklist: remove dead client-sort code and tidy frontend view-model

- Delete blacklist-table-logic.ts + test (server-side sort has subsumed
  it; grep confirmed zero runtime callers).
- Drop the unused setSearchInput return from view-model.ts.
- Extract formatBlacklistAmountCell from blacklist-table.tsx and reuse
  it for the CSV export so display and export formatting stay in lockstep.

Fixes Agent C findings H6, H7, and L1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 6 completion gate:** `npm run test:merge-gate` green.

---

## Phase 7 — Test Coverage

> **Phase goal:** fill the Agent C test gaps. Every task creates or extends a test file — all PARALLEL-SAFE. Dispatch each lane to a dedicated Opus subagent for maximum throughput.

### Task 7.1: `parseTronEvent` test suite

**Files:**
- Create: `worker/src/cron/blacklist/__tests__/tron-source.test.ts`

**Parallel-safe:** yes
**Blocked by:** 5.3 (Tron ingestion defaults changed)
**Commit:** C23

- [ ] **Step 1: Scaffold the file**

```ts
import { describe, it, expect } from "vitest";
import { parseTronEvent } from "../tron-source";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";

function findConfig(stablecoinId: string) {
  const config = CONTRACT_CONFIGS.find(
    (c) => c.stablecoinId === stablecoinId && c.chain.chainId === "tron",
  );
  if (!config) throw new Error(`No Tron config for ${stablecoinId}`);
  return config;
}
```

Note: `parseTronEvent` is currently a file-private function. Export it from `tron-source.ts`:

```ts
export function parseTronEvent(...) { … }
```

- [ ] **Step 2: Write cases**

```ts
describe("parseTronEvent", () => {
  it("parses legacy USDT AddedBlackList via _blackListedUser key", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 100,
      block_timestamp: 1_700_000_000_000,
      transaction_id: "tx_abc",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { _blackListedUser: "0xaa".padEnd(42, "a") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0xaa".padEnd(42, "a"));
    expect(row!.amount_status).toBe("recoverable_pending"); // post-Task 5.3 default
  });

  it("parses legacy USDT DestroyedBlackFunds with amount from _balance", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 200,
      block_timestamp: 1_700_000_100_000,
      transaction_id: "tx_destroy",
      event_index: 1,
      event_name: "DestroyedBlackFunds",
      result: { _blackListedUser: "0xbb".padEnd(42, "b"), _balance: "12345000000" },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("destroy");
    expect(row!.amount_native).toBe(12345); // 6 decimals
    expect(row!.amount_status).toBe("resolved");
  });

  it("parses USD1 Freeze via tronResultKey=account", () => {
    const config = findConfig("usd1-world-liberty-financial");
    const row = parseTronEvent(config, {
      block_number: 300,
      block_timestamp: 1_700_000_200_000,
      transaction_id: "tx_freeze",
      event_index: 0,
      event_name: "Freeze",
      result: { caller: "0x11".padEnd(42, "1"), account: "0x22".padEnd(42, "2") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0x22".padEnd(42, "2"));
  });

  it("returns null on unknown event name", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 400,
      block_timestamp: 1_700_000_300_000,
      transaction_id: "tx_noop",
      event_index: 0,
      event_name: "Transfer",
      result: {},
    });
    expect(row).toBeNull();
  });

  it("falls back to positional slot 0 when no named key matches", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 500,
      block_timestamp: 1_700_000_400_000,
      transaction_id: "tx_positional",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { "0": "0x33".padEnd(42, "3") },
    });
    expect(row).not.toBeNull();
    expect(row!.address).toBe("0x33".padEnd(42, "3"));
  });
});
```

- [ ] **Step 3: Run**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/tron-source.test.ts
```

Expected: all pass.

---

### Task 7.2: `backfillAmounts` test suite

**Files:**
- Extend: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts`

**Parallel-safe:** yes
**Blocked by:** 5.4 (widened WHERE clause must be in place so tests reflect current behaviour)
**Commit:** C23

- [ ] **Step 1: Create a minimal D1 mock**

If the test file doesn't already have one, create:

```ts
function createMockDb(seedRows: Array<Record<string, unknown>>): D1Database {
  // … minimal .prepare/.bind/.all/.first/.run/.batch implementation
  // that tracks the SQL statement shape and returns the seeded rows.
}
```

Alternatively, use `better-sqlite3` as a test-time backend with the real schema loaded from `worker/migrations/0000_baseline.sql`.

- [ ] **Step 2: Write test cases (minimum set — one per failure class)**

Case A — config_missing:
```ts
it("records config_missing when a row has no config_key or contract_address match", async () => {
  // row with chain_id=ethereum but contract_address=null, and multiple
  // configs exist for (stablecoin='USDC', chain_id='ethereum')
  // — getBlacklistConfigsForSymbolAndChain returns > 1 entry
  // — backfillAmounts should stamp amount_last_error_class = 'ambiguous_config'
});
```

Case B — runtime_budget mid-loop
Case C — budget_exhausted mid-loop
Case D — destroy event + receipt success
Case E — destroy event + receipt miss → historical balance success
Case F — Tron blacklist event → no longer stamps permanently_unavailable (post-5.3)
Case G — legacy derived-zero row promoted to historical_balance on fresh fetch

Fill in each test body with the required fixtures.

- [ ] **Step 3: Run**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts
```

---

### Task 7.3: `fetchDestroyAmountFromLog` unit tests

**Files:**
- Extend: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts` (new describe block) or create `__tests__/destroy-amount.test.ts`

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C23

- [ ] **Step 1: Mock `fetchWithRetry`**

Use `vi.mock("../../lib/fetch-retry", ...)` to replace `fetchWithRetry` with a `vi.fn()`.

- [ ] **Step 2: Cover 5 branches**

1. Indexed topic amount (MNEE-style): `amountTopicIndex = 2` → decoded from `topics[2]`.
2. Data-slot amount (OmnibusSeize): `amountDataIndex = 1` → decoded from data slot 1.
3. Indexed address + non-indexed amount in data: `addressFromTopic = true`, `data.length >= 66` → decoded from full data.
4. Non-indexed address + non-indexed amount: data is `[addr (32B), amount (32B)]`, decoded from `data.slice(66)`.
5. ERC20 Transfer fallback: the matching destroy event has no direct amount, but the receipt contains a `Transfer(victim → 0x0, amount)` log.

- [ ] **Step 3: Run**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/amount-recovery.test.ts -t "fetchDestroyAmountFromLog"
```

---

### Task 7.4: `parseEvmLogs` missing branch coverage

**Files:**
- Extend: `worker/src/cron/blacklist/__tests__/evm-source.test.ts`

**Parallel-safe:** yes
**Blocked by:** 6.2 (helper extraction) — adds targeted helper coverage
**Commit:** C23

- [ ] **Step 1: Add cases for the 4 untested branches**

1. **Indexed address + non-indexed data amount** (USDT0 DestroyedBlockedFunds) — verify amount decodes correctly from the full data slot.
2. **Non-indexed address + non-indexed amount via `data.slice(66)`** — USDT legacy DestroyedBlackFunds — verify the offset math.
3. **Malformed log rejection** — log with `blockNumber = "0xzz"` returns 0 rows and does not throw.
4. **Malformed `decodeAddressArrayData`** — invalid address[] data returns 0 rows and logs a warning.

- [ ] **Step 2: Run**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__/evm-source.test.ts
```

---

### Task 7.5: EURC mirror-zero flagging test

**Files:**
- Extend: `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts` or create a new `post-fetch.test.ts`

**Parallel-safe:** yes
**Blocked by:** 1.4 (`shouldSuppressAsMirrorZero` extraction)
**Commit:** C23

- [ ] **Step 1: Write a direct unit test on the helper**

Already partially covered in Task 1.4 — add integration cases that exercise `processFetchedBlacklistRows` end-to-end with an EURC blacklist row whose enrichment returns `0`, and assert `suppression_reason === "circle_mirror_zero_balance"` on the row passed to `insertBlacklistRows`.

Use `vi.mock` on `./amount-recovery` to stub `enrichRowBalances` with a spy that sets `row.amount_native = 0`.

- [ ] **Step 2: Run**

```bash
cd worker && npx vitest run src/cron/blacklist/__tests__
```

---

### Task 7.6: `blacklist-contracts` error-path coverage

**Files:**
- Extend: `worker/src/lib/__tests__/blacklist-contracts.test.ts`

**Parallel-safe:** yes
**Blocked by:** Phase 4 complete
**Commit:** C23

- [ ] **Step 1: Add cases**

```ts
  it("throws when chainConfig is called with an unknown chainId", () => {
    expect(() => chainConfig("nonexistent-chain")).toThrow(/Unknown chain/);
  });

  it("returns undefined for an unknown topic hash", () => {
    const config = CONTRACT_CONFIGS[0];
    expect(getBlacklistEventByTopic(config, "0xdeadbeef")).toBeUndefined();
    expect(getBlacklistEventByTopic(config, null)).toBeUndefined();
    expect(getBlacklistEventByTopic(config, undefined)).toBeUndefined();
  });

  it("matches topic hashes case-insensitively", () => {
    const config = CONTRACT_CONFIGS.find((c) => c.stablecoinId === "usdc-circle" && c.chain.chainId === "ethereum")!;
    const upper = "0xFFA4E6181777692565CF28528FC88FD1516EA86B56DA075235FA575AF6A4B855";
    expect(getBlacklistEventByTopic(config, upper)?.eventType).toBe("blacklist");
  });

  it("returns empty array when getBlacklistConfigsForSymbolAndChain has no match", () => {
    expect(getBlacklistConfigsForSymbolAndChain("USDC", "nowhere")).toEqual([]);
  });
```

- [ ] **Step 2: `chainConfig` must be exported** — check current export state; add `export` if missing.

- [ ] **Step 3: Run**

```bash
cd worker && npx vitest run src/lib/__tests__/blacklist-contracts.test.ts
```

- [ ] **Step 4: Commit (single grouped test-coverage commit)**

```bash
git add worker/src/cron/blacklist/__tests__ worker/src/lib/__tests__/blacklist-contracts.test.ts
git commit -m "$(cat <<'EOM'
blacklist: fill test coverage gaps (Tron, backfill, destroy recovery, EVM parse branches)

Closes the test gaps documented in Agent C T1-T10:
- New tron-source.test.ts with 5 parseTronEvent cases
- backfillAmounts coverage for config_missing, ambiguous_config,
  budget_exhausted, runtime_budget, destroy-receipt success/failure,
  legacy-derived zero promotion, and post-5.3 Tron defaults
- fetchDestroyAmountFromLog unit coverage across 5 decoder branches
- parseEvmLogs: indexed+non-indexed amount, non-indexed address+amount
  via data.slice(66), malformed log rejection, malformed address[] data
- EURC mirror-zero flagging assertion on the ingestion path
- blacklist-contracts error paths (unknown chain, unknown topic, empty
  config match)

No production code changes — all green on first run.

Fixes Agent C findings T1-T10.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 7 completion gate:** `cd worker && npx vitest run --coverage src/cron/blacklist src/lib/__tests__/blacklist-contracts.test.ts` — coverage-threshold unchanged or higher than pre-phase baseline (66% lines per `vitest.config.ts`).

---

## Phase 8 — Polish and Research

> **Phase goal:** ship the non-critical UX and the non-EVM design doc. All three tasks are parallel-safe.

### Task 8.1: `DecentralisedNoFreezeCard` transparency UI

**Files:**
- Create: `src/components/decentralised-no-freeze-card.tsx`
- Modify: `src/app/blacklist/page.tsx` — mount the card alongside `UsdsStatusCard`, `EurcBlacklistCard`
- Test: `src/components/__tests__/decentralised-no-freeze-card.test.tsx`

**Parallel-safe:** yes
**Blocked by:** Phase 6 (type unions stable)
**Commit:** C24

- [ ] **Step 1: List the verified-inert coins (per Agent B)**

```ts
const VERIFIED_NO_FREEZE: ReadonlyArray<{ symbol: string; issuer: string; summary: string }> = [
  { symbol: "DAI", issuer: "MakerDAO", summary: "Immutable token contract; no per-address freeze." },
  { symbol: "LUSD", issuer: "Liquity", summary: "Immutable protocol; no administrator." },
  { symbol: "crvUSD", issuer: "Curve", summary: "No per-address freeze mechanism." },
  { symbol: "sDAI", issuer: "MakerDAO/Sky", summary: "ERC4626 wrapper; inherits DAI's immutability." },
  { symbol: "GHO", issuer: "Aave", summary: "Facilitator/bucket architecture; no per-address restriction." },
  { symbol: "USDe", issuer: "Ethena", summary: "Standard ERC20; no blacklist." },
  { symbol: "sUSDe", issuer: "Ethena", summary: "ERC4626 wrapper around USDe; inherits no freeze." },
  { symbol: "USDD", issuer: "Tron DAO Reserve", summary: "MakerDAO-style wards on Ethereum; no per-address freeze (Ethereum deployment)." },
];
```

- [ ] **Step 2: Build the component**

Match the visual language already used by `UsdsStatusCard` and `EurcBlacklistCard`. Don't invent new card tokens — reuse existing design-system primitives. Example shape:

```tsx
"use client";

import { StatusCard } from "@/components/status-card"; // (or whatever wrapper UsdsStatusCard uses)

export function DecentralisedNoFreezeCard() {
  return (
    <StatusCard
      title="Decentralised: no freeze possible"
      description="These stablecoins' contracts emit no per-address blacklist, freeze, or seize events."
      items={VERIFIED_NO_FREEZE.map(({ symbol, issuer, summary }) => ({
        label: symbol,
        sublabel: issuer,
        detail: summary,
      }))}
    />
  );
}
```

If `StatusCard` doesn't exist, inline the layout following the same shape as `UsdsStatusCard`.

- [ ] **Step 3: Mount the card**

In `src/app/blacklist/page.tsx`, where `UsdsStatusCard` and `EurcBlacklistCard` are rendered (inside `<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">`), add:

```tsx
        <DecentralisedNoFreezeCard />
```

Choose the correct grid span — may need to bump the grid to `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`. Match existing breakpoints used elsewhere in the page.

- [ ] **Step 4: Snapshot / render test**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DecentralisedNoFreezeCard } from "../decentralised-no-freeze-card";

describe("DecentralisedNoFreezeCard", () => {
  it("lists the verified no-freeze coins", () => {
    const { getByText } = render(<DecentralisedNoFreezeCard />);
    expect(getByText("DAI")).toBeInTheDocument();
    expect(getByText("GHO")).toBeInTheDocument();
    expect(getByText("USDD")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test + `npm run build`**

```bash
npm test -- --run src/components/__tests__/decentralised-no-freeze-card.test.tsx
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/components/decentralised-no-freeze-card.tsx src/components/__tests__/decentralised-no-freeze-card.test.tsx src/app/blacklist/page.tsx
git commit -m "$(cat <<'EOM'
blacklist: add DecentralisedNoFreezeCard transparency UI

Surfaces the verified-inert coins (DAI, LUSD, crvUSD, sDAI, GHO, USDe,
sUSDe, USDD) on the /blacklist page so users understand which
stablecoins cannot be frozen by design. Mounts alongside
UsdsStatusCard and EurcBlacklistCard in the transparency row.

Refs Agent B "No-Freeze Transparency Candidates" section.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 8.2: Non-EVM schema design document

**Files:**
- Create: `agents/research/2026-04-16-blacklist-non-evm-schema-design.md`

**Parallel-safe:** yes (research-only, no code)
**Blocked by:** none
**Commit:** C25

- [ ] **Step 1: Produce a ~2-page design note**

Sections:

1. **Problem statement** — current `blacklist_events` schema assumes EVM-style events (topic hashes, indexed params, block numbers). Solana/Stellar/XRPL freeze paradigms don't fit.
2. **Option A: add `source_type` column** — enumerate `evm_event`, `tron_event`, `solana_instruction`, `stellar_flag_change`, `xrpl_trust_freeze`. `event_signature`/`event_topic0`/`block_number` become nullable for non-EVM rows. Migration plan, downstream query impact.
3. **Option B: parallel `blacklist_state_snapshots` table** — keep events table EVM-only, add a sibling table for non-event paradigms. Schema, reconciliation strategy with `blacklist_current_balances`.
4. **Recommendation** — Option A first (smaller blast radius, retains sync-state cursor pattern); Option B if Solana transfer-replay proves too expensive to fit in the events table.
5. **Data source notes** — per chain: SPL Token Program instruction indexing (Helius/Triton), Stellar Horizon `accounts?asset_issuer=...&authorized=false`, XRPL `ledger_entry` TrustLine queries.
6. **Target coin list** — USDT/USDC Solana, PYUSD Solana, USDG Solana, USDP Solana, EURC Solana, EURC Stellar, RLUSD XRPL, USDC Stellar, USDP Stellar.
7. **Open questions** — reconciliation with the EVM `active_state` machine, UX treatment on `/blacklist` for cross-chain entities, cron scheduling impact.

- [ ] **Step 2: Commit**

```bash
git add agents/research/2026-04-16-blacklist-non-evm-schema-design.md
git commit -m "$(cat <<'EOM'
docs: non-EVM blacklist schema design draft (Solana/Stellar/XRPL)

Design note covering Option A (add `source_type` column) vs. Option B
(parallel snapshot table) for extending the blacklist tracker to
non-event paradigms. Recommends Option A with a fallback to Option B
if Solana transfer-replay proves too expensive.

Refs Agent B Priority 3 feasibility section.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

### Task 8.3: Filter loading state

**Files:**
- Modify: `src/components/blacklist-filters.tsx`

**Parallel-safe:** yes
**Blocked by:** none
**Commit:** C26

- [ ] **Step 1: Add a `disabled` state when the chain list hasn't loaded**

```tsx
  const isChainsLoading = chains.length === 0;
  // … dropdown markup:
  <Select
    value={chainFilter}
    onValueChange={onChainChange}
    disabled={isChainsLoading}
  >
```

Display a `Loading…` item or a skeleton row when `isChainsLoading`.

- [ ] **Step 2: Test + build**

```bash
npm test -- --run src/components/__tests__
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/blacklist-filters.tsx
git commit -m "$(cat <<'EOM'
blacklist: show loading state on filter dropdowns

Disables the chain filter and shows a loading label while the summary
payload resolves, replacing the previous "All" stub that briefly
appeared before the chain list arrived.

Refs Agent C finding L6.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOM
)"
```

---

**Phase 8 completion gate:** `npm run test:merge-gate` green on all of `main`.

---

## Self-Review Checklist

Run this against the plan itself before handing off to execution:

- [ ] **Spec coverage:** every finding in Agents A/B/C/D is mapped to a task
  - Agent A: H1 → 1.1, H3 → 1.3/2.x, C1 → 1.2, H2 → 3.1-3.3, H5 → 1.5, M1/M2 → 1.4, M3/M4/M5/M6/M7 → Phase 6 (6.x) or deferred with justification
  - Agent B: P0 → 4.1, P1 USDC → 4.2, P1 USDT0 → 4.3, P1 USDP → 4.4, P1 EURC WC → 4.5, P1 TUSD → 4.6, P2 non-EVM → 8.2, transparency card → 8.1
  - Agent C: **H1 was already resolved pre-audit (exists in `worker/src/cron/blacklist/post-fetch-counters.ts`); no task dispatched.** H2 → 6.2, H3 → deferred pending test gap closure (split between 6.x and Phase 7), H4/H5 → 6.1, H6 → 6.9, H7 → 6.10, M1 → 6.4, M3 → 6.5, M4 → 6.6, M5 → 6.7, M8 → 6.8, M9 → 7.5, L1 → 6.11, L6 → 8.3, T1-T10 → Phase 7
  - Agent D: C1 → 5.4, C2 → 5.2, H1 → 5.4, H2 → deferred (provenance re-label will happen during 5.4 success path), H3 → 5.3
- [ ] **No placeholders** — every code block is concrete except where a value must be retrieved live (explicit `<deploy block>` markers are annotated with retrieval commands).
- [ ] **Type consistency** — the `BlacklistAmountSource` union is the same across Tasks 5.1, 5.2, 5.4, 5.5, 5.6; the sibling `z.enum([...])` on `BlacklistEventSchema` is updated in the same task (Step 2b); `effectiveEventType` in 4.6 matches the TUSD decoder wiring and `buildBlacklistRow` signature change.
- [ ] **Commit boundaries** — 26 commits, each thematic, each runnable through `npm run test:merge-gate`.
- [ ] **Parallel safety** — within each phase, lanes are labelled `parallel-safe: yes|no` and the blocker graph in the top-of-file map is internally consistent. Phase 6 Lane B has exactly one task (6.2) after Task 6.3 was removed as stale.

---

## Execution Handoff

**Plan complete.** Two execution options:

**1. Subagent-driven (recommended for Phases 1, 6, 7, 8)** — dispatch one fresh Opus subagent per task or lane; review each task's diff against the plan before merging. Use `superpowers:subagent-driven-development`.

**2. Inline execution (recommended for Phases 2, 3, 4, 5)** — these phases are serial (shared files or cross-task dependencies). Execute tasks in this session with checkpoints for review. Use `superpowers:executing-plans`.

The user-preferred flow is subagent-driven where parallelism helps and inline for serial phases, committing in thematic batches as described in the Commit Batching Plan table. Begin with Phase 1, run review loop on this plan document first (minor issues < 2), then start execution.
