# Daily & Weekly Digest Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-04-16
**Revision:** 3 (READY TO EXECUTE — Review 3 returned Critical 0, High 0, Minor 0)

**Goal:** Lift the daily and weekly Pharos digests from "well-structured but templatic" to "informative, actionable, sometimes spicy, always entertaining" — while migrating to `claude-opus-4-7` with maximum reasoning effort and fixing the meta-normalization and variety-enforcement bugs exposed by the currently deployed output.

**Architecture:** Keep the existing worker-cron architecture (Anthropic HTTP call, editorial candidates, D1 storage, circuit-aware social delivery). Change the model request shape to Opus 4.7's adaptive-thinking + max-effort contract; tighten the prompts with phrase bans, opening-variety rules, a forward-look mandate, and a compact few-shot exemplar; expand variety enums so the model's natural lead/tone tokens survive normalization while keeping a coarse `leadFamily` group for variety enforcement; surface novelty-driven "Momentum candidates" as forward-watch material; add chain-level mint/burn breakdown, total mcap ATH context, and weekly week-over-week deltas; prune one low-signal prompt block. All contracts validated by updating existing Vitest suites in `worker/src/cron/__tests__/`.

**Tech Stack:** TypeScript, Cloudflare Worker (D1, cron triggers), Anthropic Messages API via `fetchWithRetry` (raw HTTP, preserving existing circuit-breaker and retry infrastructure), Vitest, Zod schemas, shared types in `@shared/types/digest`.

---

## Success Criteria

1. Production digest pipeline calls `claude-opus-4-7` with `thinking: {type: "adaptive"}` and `output_config: {effort: "max"}`. Contract is verified pre-deploy by querying the live Models API for capability support.
2. `max_tokens` and `ANTHROPIC_TIMEOUT_MS` are sized for max-effort thinking (no request truncation or client-side timeout in normal runs).
3. Lead and tone enums cover the model's observed natural outputs; normalization no longer collapses ≥30% of leads and tones to `"other"`.
4. A coarse `leadFamily` derivation (e.g., `psi`, `depeg`, `dews`, `flow`, `risk`, `macro`) drives variety enforcement even as the fine-grained `lead` enum expands, so `repeated-lead-family` fires correctly.
5. Weekly meta fields (`lead`, `tone`, `coins`) are normalized on the same contract as daily and usable for weekly variety checks.
6. Prompts explicitly forbid a fixed list of house-style tics ("plumbing", "beneath the calm", "surface … underneath", "restless depths", "calm surfaces,", "something moving underneath", "serene", etc.), with a corrective retry when the model returns any of them. The "worth watching" weasel closer is banned only in terminal-sentence position to avoid over-aggressive retries.
7. Each digest opens with a fact drawn from the lead editorial candidate, not a templated PSI verb. The quality gate rejects a repeated opening fingerprint against the last 3 daily digests (or last 2 weekly recaps).
8. Every daily digest includes one forward-look line (explicit or implicit "what to watch next"); enforced at the prompt level and checked by a soft validator.
9. Weekly recap receives week-over-week (this week vs prior week) deltas for total mcap, PSI midpoint, PSI dominant band, active-depeg observations, unique depeg signals, blacklist event count and USD, grade transitions, and Bank Run Gauge midpoint.
10. Daily input includes a chain-level mint/burn breakdown (top 3 chains by absolute net flow) and a `totalMcapAth` context.
11. A Momentum Candidates block surfaces candidates with `novelty ∈ {new, accelerating, reversal}` so the model has an explicit forward-watch surface upstream of the regex-based forward-look validator.
12. A compact few-shot exemplar (one ~130-word model digest) is embedded in the daily system prompt, anchoring voice and structure.
13. `safetyScores.distribution` aggregate counts are dropped from the prompt surface; the frontend-consumed fields (`medianGrade`, `aboveBCount`, `fCount`) remain in the stored `input_data` snapshot so `/digest/[date]/` pages continue to render the Safety Scores card.
14. Docs (`docs/digest-pipeline.md`, `docs/worker-and-api-limits.md`) match the deployed code. A repo-wide grep confirms no stale `opus-4-6` references outside `agents/plans/historical/`.
15. Test suite runs clean: `worker/src/cron/__tests__/daily-digest.test.ts`, `worker/src/cron/__tests__/weekly-recap.test.ts`, `worker/src/api/__tests__/daily-digest.test.ts`, `worker/src/api/__tests__/digest-snapshot.test.ts`.
16. `cd worker && npx tsc --noEmit` succeeds.

## Non-Goals

- Frontend rendering changes (broadsheet component, archive table, detail pages). Safety Scores card keeps reading `medianGrade`/`aboveBCount`/`fCount` from `input_data` — no change.
- New distribution channels (RSS, email, webhook).
- A full rewrite of `buildUserPrompt` into data-driven templates — keep prose concatenation; add new blocks only.
- Changing the 08:05 UTC cron slot.
- Switching from raw HTTP (`fetchWithRetry`) to the Anthropic SDK — existing circuit-breaker / retry infrastructure preserved.
- Prompt caching (not useful for a once-daily cron).
- Structured outputs (`output_config.format`) — deferred.
- Streaming — deferred unless post-deploy observation shows client-timeout misses at 300s.

---

## Research Summary

- **Model state:** `worker/src/cron/digest/platform.ts:89` sends `claude-opus-4-6`. No `thinking`, no `output_config`, no sampling params. `ANTHROPIC_TIMEOUT_MS = 120_000`. Daily `max_tokens = 1400`, weekly `max_tokens = 2000`.
- **Opus 4.7 contract (confirmed from `claude-api` skill doc cached 2026-04-15):** `claude-opus-4-7`; `thinking: {type: "adaptive"}` is the only enabled-thinking form accepted on 4.7; `thinking.type: "enabled"` with `budget_tokens` returns 400; `temperature` / `top_p` / `top_k` are removed on 4.7 (400 if sent); `output_config.effort: "max"` is the Opus-tier maximum reasoning setting (GA, no beta header); adaptive thinking's output display defaults to `"omitted"` (fine for a cron).
- **Enum gap (observed in production D1):** Model produces leads like `dews-stress-gyd`, `liquidity-shift-usdp`, `gauge-divergence-psi`, `psi-band-change`, `gauge-flip`, `gauge-trajectory-dola-pressure`. All collapse to `"other"` under the current `normalizeToken`. `repeated-lead` can never fire because every unmatched lead is the same token `"other"`.
- **Tone skew:** 12 of the last 25 digests (≈48%) carry `tone=foreboding`. The three-day repetition window does not prevent mid-term skew.
- **House-style tics in recent prose:** "plumbing" (5+), "beneath the calm"/"underneath" (6+), "surface"/"surfaces" (4+), "restless depths" (3+), "calm surfaces, restless depths" (2 verbatim repeats). The existing `FORBIDDEN_PHRASES` in `response.ts` covers only throat-clearing, not tics.
- **Opening template:** Near-every recent daily digest opens with "PSI sits / slipped / ticked / held at X". The prompt tells the model to lead from candidates, but the constraint is not programmatic.
- **Forward-look cadence:** Only ≈40% of recent daily digests carry an anticipatory line.
- **Weekly narrative richness:** Weekly recaps receive structured weekly signal leaderboards (prior remediation). They do NOT receive week-over-week deltas vs the prior week.
- **Safety distribution frontend usage:** `src/components/digest-snapshot.tsx:267-269` renders `medianGrade`, `aboveBCount`, `fCount` from `input_data`. Collector must keep writing these; only the prompt surface loses them.
- **Novelty already computed:** `editorial-candidates.ts` assigns `novelty ∈ {new, worsening, improving, reversal, accelerating, decelerating, recurring, chronic, structural}`. The prompt currently does not highlight momentum-oriented novelty ({new, accelerating, reversal}) as forward-watch material — easy to surface.

---

## File Structure

### New files

- `worker/src/cron/daily-digest/voice-guards.ts` — forbidden-phrase patterns (with position-scoped rules for "worth watching"), opening-pattern fingerprinter, forward-look detector, `leadFamily` mapper. ~160 lines.

### Modified files

- `worker/src/lib/constants.ts` — `ANTHROPIC_TIMEOUT_MS`.
- `worker/src/cron/digest/platform.ts` — Anthropic request body: model, `thinking`, `output_config`.
- `worker/src/cron/daily-digest.ts` — `maxTokens` default.
- `worker/src/cron/weekly-recap.ts` — `maxTokens`; WoW delta wiring; prompt; WoW cutoff; `LIMIT 15` on the daily-rows query.
- `worker/src/cron/daily-digest/prompt.ts` — rewritten system prompt (opening rule, forward-look mandate, spice budget, tic list, few-shot exemplar); new blocks: chain mint/burn, total mcap ATH, Momentum Candidates; drop safety distribution aggregate line.
- `worker/src/cron/daily-digest/response.ts` — expanded `ALLOWED_LEADS` and `ALLOWED_TONES`; integration of voice guards (tics, opening fingerprint, forward-look); `repeated-lead-family` validator; `tone-cluster` validator.
- `worker/src/cron/daily-digest/collectors-market.ts` — `collectMintBurnFlows` returns `topChains`.
- `worker/src/cron/daily-digest/collectors-history.ts` — new `collectTotalMcapAth`; export from `collectors.ts`.
- `worker/src/cron/daily-digest/input.ts` — wire `topChains`, `totalMcapAth`; pass candidate novelty to prompt via Momentum block.
- `worker/src/cron/daily-digest/editorial-candidates.ts` — expose novelty-filtered helper `selectMomentumCandidates(candidates)`.
- `shared/types/digest.ts` — extend `mintBurnFlows` with `topChains?`, add `totalMcapAth?` on `DigestInputData`; extend `WeeklyInputData` with `weekOverWeekDeltas?`.
- `worker/src/lib/schemas.ts` — unchanged (DigestResponseSchema still accepts optional meta).
- `docs/digest-pipeline.md`, `docs/worker-and-api-limits.md` — bump model, document new fields and guards.

### Test files

- `worker/src/cron/__tests__/daily-digest.test.ts` — new assertions per task.
- `worker/src/cron/__tests__/weekly-recap.test.ts` — new assertions per task.
- `worker/src/api/__tests__/daily-digest.test.ts`, `worker/src/api/__tests__/digest-snapshot.test.ts` — keep green; no functional change.

---

## Execution Order

Dependency-correct order (new tasks add data BEFORE prompt-rewrite tasks that reference that data):

| #  | Task                                                              | Risk   |
|----|-------------------------------------------------------------------|--------|
| 1  | Bump `ANTHROPIC_TIMEOUT_MS` to 300s (daily + weekly assertions)   | Low    |
| 2  | Migrate request body to Opus 4.7 + adaptive thinking + max effort + pre-deploy capability verification | Medium |
| 3  | Raise `max_tokens`: 16000 daily, 20000 weekly (+ cost disclaimer) | Low    |
| 4  | Expand `ALLOWED_LEADS` + `ALLOWED_TONES`; add `leadFamily` mapper + `repeated-lead-family` validator | Low |
| 5  | Extend variety window: tone-cluster (3-of-5) soft validator       | Low    |
| 6  | Voice guard: forbidden-phrase list (`worth watching` scoped to closer position only) | Low |
| 7  | Voice guard: opening-sentence fingerprint + repetition detector   | Medium |
| 8  | Voice guard: forward-look mandate (soft validator)                | Low    |
| 9  | New data: chain-level mint/burn breakdown                         | Low    |
| 10 | New data: `totalMcapAth` context (SQL via `ORDER BY ... LIMIT 1`) | Low    |
| 11 | New data: Momentum Candidates block in prompt (novelty-driven)    | Low    |
| 12 | New data: weekly WoW deltas (with `LIMIT 15`, harmonized field names) | Medium |
| 13 | Daily prompt rewrite (structure, opening rule, spice, tic list, few-shot exemplar, new data references) | Medium |
| 14 | Weekly prompt rewrite (arc, forward-look, tic list, WoW references) | Medium |
| 15 | Drop `safetyScores.distribution` line from prompt surface         | Low    |
| 16 | Weekly meta normalization verification test                       | Low    |
| 17 | Docs updates (includes repo-wide `opus-4-6` grep)                  | Low    |
| 18 | Local verification + live-fixture replay + voice review gate      | —      |

Each task commits independently tagged `feat(digest):`, `fix(digest):`, `simplify(digest):`, `test(digest):`, or `docs(digest):`.

---

## Task 1: Bump Anthropic timeout to 300 seconds (daily + weekly)

**Files:**
- Modify: `worker/src/lib/constants.ts:197-201`
- Test: `worker/src/cron/__tests__/daily-digest.test.ts`, `worker/src/cron/__tests__/weekly-recap.test.ts`

**Why:** Max-effort adaptive thinking on Opus 4.7 commonly runs 30–120 seconds of model-side think time for a digest-sized task. The existing 120s client timeout leaves essentially no buffer. The cron slot has ~25 minutes of downstream runway.

- [ ] **Step 1: Write failing tests** — both daily and weekly happy-path.

```typescript
// daily-digest.test.ts (replace existing assertion)
expect(fetchWithRetry).toHaveBeenCalledWith(
  "https://api.anthropic.com/v1/messages",
  expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ "x-api-key": "anthropic-key" }),
  }),
  ANTHROPIC_MAX_RETRIES,
  { timeoutMs: 300_000 },
);
```

```typescript
// weekly-recap.test.ts — add in happy path, import ANTHROPIC_MAX_RETRIES
import { ANTHROPIC_MAX_RETRIES } from "../../lib/constants";

expect(fetchWithRetry).toHaveBeenCalledWith(
  "https://api.anthropic.com/v1/messages",
  expect.any(Object),
  ANTHROPIC_MAX_RETRIES,
  { timeoutMs: 300_000 },
);
```

- [ ] **Step 2: Run tests to verify fail**

```
cd worker && npx vitest run src/cron/__tests__/daily-digest.test.ts src/cron/__tests__/weekly-recap.test.ts
```
Expected: FAIL — actual `timeoutMs: 120_000`.

- [ ] **Step 3: Implement**

```typescript
// worker/src/lib/constants.ts
/** Anthropic digest generation request timeout.
 *  Sized for Opus 4.7 max-effort adaptive thinking on digest-sized tasks.
 */
export const ANTHROPIC_TIMEOUT_MS = 300_000;
```

- [ ] **Step 4: Run tests to verify pass** — same commands; expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/weekly-recap.test.ts
git commit -m "feat(digest): raise Anthropic client timeout to 300s for Opus 4.7 max effort"
```

---

## Task 2: Migrate request body to Opus 4.7 with adaptive thinking + max effort

**Files:**
- Modify: `worker/src/cron/digest/platform.ts:85-97`
- Tests: daily and weekly happy paths assert new body shape
- One-time operational verification: query the Models API to confirm capability support before the PR merges.

**Why:** User requirement (`opus-4.7-max-effort`). Per `claude-api` skill (cached 2026-04-15): Opus 4.7 accepts `thinking: {type: "adaptive"}` (the only enabled-thinking form on 4.7); `output_config: {effort: "max"}` is the Opus-tier maximum reasoning setting. `temperature` / `top_p` / `top_k` are removed (400 if sent) — the existing code does not pass any, so no removal needed. `thinking.budget_tokens` is also removed on 4.7 — we do not set it.

### Pre-commit capability verification (manual, one-time)

Before running the production test suite, hit the Models API from a local shell to confirm `claude-opus-4-7` supports both parameters we intend to send. If either is reported `supported: false`, stop and revisit. This protects against a silent 400 if the cached doc has drifted.

```bash
curl -s https://api.anthropic.com/v1/models/claude-opus-4-7 \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  | jq '{id, capabilities: {adaptive: .capabilities.thinking.types.adaptive.supported, effort_max: .capabilities.effort.max.supported}}'
```

Expected: `{"id": "claude-opus-4-7", "capabilities": {"adaptive": true, "effort_max": true}}`.

If the response ever shows `adaptive: false` or `effort_max: false`, escalate — we probably missed a contract update. Record the verification in the PR description.

- [ ] **Step 1: Write the failing tests**

```typescript
// daily-digest.test.ts — happy path
const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
  model: string;
  thinking?: { type: string };
  output_config?: { effort: string };
  max_tokens: number;
  system: string;
  messages: { content: string }[];
};
expect(body.model).toBe("claude-opus-4-7");
expect(body.thinking).toEqual({ type: "adaptive" });
expect(body.output_config).toEqual({ effort: "max" });
```

```typescript
// weekly-recap.test.ts — mirror assertions
const weeklyBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
  model: string;
  thinking?: { type: string };
  output_config?: { effort: string };
  max_tokens: number;
  system: string;
};
expect(weeklyBody.model).toBe("claude-opus-4-7");
expect(weeklyBody.thinking).toEqual({ type: "adaptive" });
expect(weeklyBody.output_config).toEqual({ effort: "max" });
```

- [ ] **Step 2: Run tests to verify fail**

```
cd worker && npx vitest run src/cron/__tests__/daily-digest.test.ts src/cron/__tests__/weekly-recap.test.ts
```
Expected: FAIL — actual `model` is `claude-opus-4-6`, `thinking`/`output_config` undefined.

- [ ] **Step 3: Implement — rewrite the request body in `platform.ts`**

Replace the `body: JSON.stringify({...})` block with:

```typescript
body: JSON.stringify({
  model: "claude-opus-4-7",
  max_tokens: options.maxTokens,
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  system: options.systemPrompt,
  messages: [{ role: "user", content: userPrompt }],
}),
```

Do NOT add `temperature`, `top_p`, `top_k`, `thinking.budget_tokens`, or `thinking.display` — adaptive-display default is `"omitted"`, which is fine because we never surface thinking text to readers.

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Run the Models-API capability check** (see top of task). Paste the result into the PR description.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/digest/platform.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/weekly-recap.test.ts
git commit -m "feat(digest): upgrade to Opus 4.7 with adaptive thinking and max effort"
```

---

## Task 3: Raise `max_tokens` defaults for thinking headroom

**Files:**
- Modify: `worker/src/cron/daily-digest.ts` (`maxTokens: 1400` → `16000`)
- Modify: `worker/src/cron/weekly-recap.ts` (`maxTokens: 2000` → `20000`)
- Tests: both happy paths

**Why:** `max_tokens` is an enforced per-response ceiling covering thinking + output combined. Per the claude-api skill: default non-streaming ~16000. A digest's final text is ~500 tokens; max-effort adaptive thinking can easily consume tens of thousands of tokens mid-response.

**Cost disclaimer:** Opus 4.7 output is ~$75/Mtok. A 16k worst-case daily run costs ~$1.20; 20k weekly run ~$1.50. Annualized ≈$550 if every run hits the cap. In practice adaptive thinking won't max the ceiling every day. Acceptable for a product feature. Worth monitoring `usage.output_tokens` across the first week post-deploy.

- [ ] **Step 1: Write failing tests**

```typescript
// daily-digest.test.ts happy path
expect(body.max_tokens).toBe(16000);

// weekly-recap.test.ts happy path
expect(weeklyBody.max_tokens).toBe(20000);
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

```typescript
// worker/src/cron/daily-digest.ts
const digestCopy = await requestDigestCopy({
  // ...
  maxTokens: 16000,
  // ...
});
```

```typescript
// worker/src/cron/weekly-recap.ts
const digestCopy = await requestDigestCopy({
  // ...
  maxTokens: 20000,
  // ...
});
```

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/weekly-recap.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/weekly-recap.test.ts
git commit -m "feat(digest): raise max_tokens to 16k/20k for thinking headroom"
```

---

## Task 4: Expand `ALLOWED_LEADS` + `ALLOWED_TONES`; add `leadFamily` mapper

**Files:**
- Modify: `worker/src/cron/daily-digest/response.ts:60-93` (enums)
- Create: (part of) `worker/src/cron/daily-digest/voice-guards.ts` — `leadFamily(lead)` mapper
- Modify: `worker/src/cron/daily-digest/response.ts` — replace `repeated-lead` check with `repeated-lead-family`
- Test: `daily-digest.test.ts`

**Why:** Current enums are so narrow that ≥30% of observed model leads / tones collapse to `"other"`. Expanding captures reality. BUT — expanding the lead enum to 28+ values makes combinatorial variety enforcement collapse from the opposite side: if every PSI-related lead is a distinct token (`psi-streak`, `psi-regime`, `psi-band-change`, `psi-divergence`), yesterday's `psi-regime` won't match today's `psi-streak` and the variety check fires unreliably. Solution: keep fine-grained tokens for analytics, add a coarse `leadFamily` mapper for variety. Six families: `psi`, `depeg`, `dews`, `flow`, `risk`, `macro`. `repeated-lead-family` fires when the same family recurs ≥2 of last 3.

- [ ] **Step 1: Write the failing tests**

```typescript
// daily-digest.test.ts
import { parseDigestModelResponse, validateDigestModelOutput } from "../daily-digest/response";

describe("parseDigestModelResponse meta normalization", () => {
  function parse(leadValue: string, toneValue: string): { lead?: string; tone?: string } {
    const raw = JSON.stringify({
      title: "T", text: "T.",
      extended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      meta: { lead: leadValue, tone: toneValue, coins: ["USDT"] },
    });
    const parsed = parseDigestModelResponse(raw);
    const meta = parsed.digestMeta ? (JSON.parse(parsed.digestMeta) as Record<string, string>) : {};
    return { lead: meta.lead, tone: meta.tone };
  }

  it("retains observed natural lead tokens", () => {
    expect(parse("gauge-flip", "dry").lead).toBe("gauge-flip");
    expect(parse("psi-band-change", "dry").lead).toBe("psi-band-change");
    expect(parse("issuer-concentration", "dry").lead).toBe("issuer-concentration");
    expect(parse("regime-divergence", "dry").lead).toBe("regime-divergence");
  });

  it("retains observed natural tones", () => {
    expect(parse("depeg", "sardonic").tone).toBe("sardonic");
    expect(parse("depeg", "observant").tone).toBe("observant");
    expect(parse("depeg", "forensic").tone).toBe("forensic");
  });

  it("collapses garbage to 'other'", () => {
    expect(parse("asdfghjkl", "dry").lead).toBe("other");
    expect(parse("depeg", "asdfghjkl").tone).toBe("other");
  });
});

describe("lead family variety check", () => {
  function issues(currentLead: string, recentLeads: string[]) {
    const parsed = {
      digestTitle: "T", digestText: "T.",
      digestExtended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      digestMeta: JSON.stringify({ lead: currentLead, tone: "dry", coins: ["USDT"] }),
      strippedDashCount: 0, strippedForbiddenCharCount: 0, usedRawTextFallback: false,
    };
    const recentMeta = recentLeads.map((l) => ({
      meta: { lead: l, tone: "dry" } as Record<string, unknown>, title: "x",
    }));
    return validateDigestModelOutput(parsed, { kind: "daily", recentMeta });
  }

  it("fires repeated-lead-family when family repeats 2 of last 3", () => {
    const result = issues("psi-streak", ["psi-regime", "psi-band-change", "supply-reversal"]);
    expect(result.some((i) => i.code === "repeated-lead-family")).toBe(true);
  });

  it("does not fire when lead families differ", () => {
    const result = issues("psi-streak", ["depeg", "grade-transition", "ftq"]);
    expect(result.some((i) => i.code === "repeated-lead-family")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

```
cd worker && npx vitest run src/cron/__tests__/daily-digest.test.ts -t "meta normalization|lead family"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `worker/src/cron/daily-digest/voice-guards.ts` (will be extended by later tasks):

```typescript
export function leadFamily(lead: string | undefined): string | undefined {
  if (!lead) return undefined;
  if (lead.startsWith("psi-") || lead === "psi") return "psi";
  if (lead.includes("depeg")) return "depeg";
  if (lead.startsWith("dews")) return "dews";
  if (lead === "ftq" || lead.startsWith("mint-burn") || lead.startsWith("gauge-")
    || lead.startsWith("supply-") || lead === "chain-migration") return "flow";
  if (lead === "grade-transition" || lead === "yield-anomaly" || lead === "liquidity-shift"
    || lead === "blacklist-contrast" || lead === "reserve-event") return "risk";
  if (lead === "macro-observation" || lead === "market-structure"
    || lead === "issuer-concentration" || lead === "regime-divergence") return "macro";
  return "other";
}
```

Expand enums in `response.ts`:

```typescript
const ALLOWED_LEADS = new Set([
  "psi-streak", "psi-regime", "psi-band-change", "psi-divergence",
  "depeg", "resolved-depeg", "chronic-depeg",
  "dews-band-change", "dews-alert-breadth", "dews-warning",
  "ftq", "mint-burn", "gauge-flip", "gauge-divergence",
  "supply-reversal", "supply-acceleration", "supply-deceleration", "chain-migration",
  "grade-transition", "blacklist-contrast", "reserve-event", "yield-anomaly", "liquidity-shift",
  "macro-observation", "market-structure", "issuer-concentration", "regime-divergence",
  "other",
]);

const ALLOWED_TONES = new Set([
  "bemused", "foreboding", "clinical", "wistful", "darkly-amused", "urgent",
  "dry", "analytical", "calm", "skeptical",
  "sardonic", "observant", "forensic", "resigned", "ironic",
  "other",
]);
```

Replace the existing `repeated-lead` block in `validateDigestModelOutput` with `repeated-lead-family`:

```typescript
import { leadFamily } from "./voice-guards";

// ... inside validateDigestModelOutput, remove existing repeated-lead block, add:
const currentFamily = leadFamily(lead ?? undefined);
if (currentFamily && currentFamily !== "other") {
  const recentFamilies = recentThree
    .map((entry) => leadFamily(getMetaString(entry.meta, "lead") ?? undefined))
    .filter((f): f is string => f != null && f !== "other");
  if (recentFamilies.filter((f) => f === currentFamily).length >= 2) {
    issues.push({
      code: "repeated-lead-family",
      severity: "soft",
      message: `Lead family '${currentFamily}' repeats ${recentFamilies.filter((f) => f === currentFamily).length} of last 3 digests.`,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```
cd worker && npx vitest run src/cron/__tests__/daily-digest.test.ts -t "meta normalization|lead family"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/voice-guards.ts worker/src/cron/daily-digest/response.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): expand lead/tone enums and add leadFamily variety check"
```

---

## Task 5: Tone-cluster validator (3-of-5 soft)

**Files:**
- Modify: `worker/src/cron/daily-digest/response.ts`
- Test: `daily-digest.test.ts`

**Why:** 48% of recent daily tones are `foreboding`. The 3-day variety window is too short to catch mid-term skew. Promote the window to 5 days and add a `tone-cluster` rule that fires if the same tone appears ≥3 of last 5 non-weekly digests. Soft severity — a single repeat ships; the retry prompt surfaces the issue so Claude varies on the second try.

- [ ] **Step 1: Write the failing test**

```typescript
describe("tone cluster validator", () => {
  function parsedFixture(toneOverride = "foreboding") {
    return {
      digestTitle: "T", digestText: "T.",
      digestExtended: "T. T. T.\n\nT. T. T.\n\nT. T. T.",
      digestMeta: JSON.stringify({ lead: "depeg", tone: toneOverride, coins: ["USDT"] }),
      strippedDashCount: 0, strippedForbiddenCharCount: 0, usedRawTextFallback: false,
    };
  }
  it("fires tone-cluster when same tone appears 3+ times in last 5", () => {
    const recent = Array.from({ length: 5 }, () => ({
      meta: { lead: "depeg", tone: "foreboding" } as Record<string, unknown>,
      title: "prior",
    }));
    const result = validateDigestModelOutput(parsedFixture(), { kind: "daily", recentMeta: recent });
    expect(result.some((i) => i.code === "tone-cluster")).toBe(true);
  });
  it("does not fire when spread across tones", () => {
    const recent = [
      { meta: { tone: "dry" }, title: "a" }, { meta: { tone: "sardonic" }, title: "b" },
      { meta: { tone: "foreboding" }, title: "c" }, { meta: { tone: "clinical" }, title: "d" },
      { meta: { tone: "wistful" }, title: "e" },
    ];
    const result = validateDigestModelOutput(parsedFixture(), { kind: "daily", recentMeta: recent });
    expect(result.some((i) => i.code === "tone-cluster")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement — add to `validateDigestModelOutput` after the existing `repeated-tone` block**

```typescript
const recentFive = recent.slice(0, 5);
if (tone) {
  const sameToneCount = recentFive.filter((entry) => getMetaString(entry.meta, "tone") === tone).length;
  if (sameToneCount >= 3) {
    issues.push({
      code: "tone-cluster",
      severity: "soft",
      message: `Tone '${tone}' appeared ${sameToneCount} times in last 5 digests; pick a different register.`,
    });
  }
}
```

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/response.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): flag tone-cluster when same register appears 3+/5"
```

---

## Task 6: Voice guard — forbidden-phrase list (with `worth watching` closer-scoped)

**Files:**
- Modify: `worker/src/cron/daily-digest/voice-guards.ts` (append)
- Modify: `worker/src/cron/daily-digest/response.ts` (integrate)
- Test: `daily-digest.test.ts`

**Why:** House-style tics ("plumbing", "beneath the calm", "restless depths", "calm surfaces,") recur across recent output. We add a soft validator that names the tic and triggers the corrective retry prompt. We do NOT silently strip tics (sentence grammar would break).

**Reviewer-correction:** The raw phrase `worth watching` is idiomatic for market commentary; a blanket ban would retry every run. Scope the ban to **closer position** (last sentence of the extended field and/or the text hook), where its use signals template filler rather than substance.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("forbidden-tic voice guard", () => {
  function parsedFixture(extended: string, text = "T.") {
    return {
      digestTitle: "T", digestText: text, digestExtended: extended,
      digestMeta: JSON.stringify({ lead: "depeg", tone: "dry", coins: ["USDT"] }),
      strippedDashCount: 0, strippedForbiddenCharCount: 0, usedRawTextFallback: false,
    };
  }
  it("flags plumbing metaphor anywhere in extended", () => {
    const issues = validateDigestModelOutput(
      parsedFixture("PSI held.\n\nThe plumbing flinched again.\n\nDone."),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(true);
  });
  it("flags 'worth watching' in closer position", () => {
    const issues = validateDigestModelOutput(
      parsedFixture("Line one.\n\nLine two.\n\nLine three, worth monitoring into next week."),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(true);
  });
  it("does NOT flag 'worth watching' in mid-paragraph non-closer position", () => {
    const issues = validateDigestModelOutput(
      parsedFixture("A coin worth watching for mcap drift, plus five others. Real closer.\n\nLine two.\n\nLine three."),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(false);
  });
  it("does not flag prose free of tics", () => {
    const issues = validateDigestModelOutput(
      parsedFixture("USDT added $3B.\n\nUSDC pulled $200M.\n\nThe gap is now the story."),
      { kind: "daily", recentMeta: [] },
    );
    expect(issues.some((i) => i.code === "forbidden-tic")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Append to `voice-guards.ts`:

```typescript
/** Tics banned anywhere in the output. */
export const FORBIDDEN_TICS_ANYWHERE: { pattern: RegExp; label: string }[] = [
  { pattern: /\bplumbing\b/i, label: "plumbing" },
  { pattern: /\bbeneath the (?:calm|bedrock|surface|placid)\b/i, label: "beneath the calm" },
  { pattern: /\brestless (?:depths|plumbing|surface|currents?)\b/i, label: "restless depths" },
  { pattern: /\bcalm surface[s]?,/i, label: "calm surfaces," },
  { pattern: /\bsurface calm\b/i, label: "surface calm" },
  { pattern: /\b(?:something|someone) (?:is )?moving (?:under|beneath)(?:neath)?\b/i, label: "moving underneath" },
  { pattern: /\bthe plumbing (?:flinched|said|is)\b/i, label: "the plumbing flinched" },
  { pattern: /\bserene\b/i, label: "serene" },
  { pattern: /\btime will tell\b/i, label: "time will tell" },
  { pattern: /\bthe question is whether\b/i, label: "the question is whether" },
  { pattern: /\bit is worth asking whether\b/i, label: "it is worth asking whether" },
];

/** Tics banned only in terminal-sentence / closer position.
 *  The regex does NOT anchor to end-of-string — `findForbiddenTics` already
 *  scopes the haystack to the last sentence of the last paragraph and the
 *  text-hook's last sentence, so re-anchoring here would miss phrases
 *  followed by a short tail like "into next week." */
export const FORBIDDEN_TICS_CLOSER: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:worth watching|worth monitoring|bears? watching)\b/i, label: "worth watching/monitoring (closer)" },
];

export function getLastSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1] ?? "";
}

export function getLastParagraph(text: string): string {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? "";
}

export function findForbiddenTics(digestText: string, digestExtended: string): string[] {
  const hits: string[] = [];
  const haystack = `${digestText}\n${digestExtended}`;
  for (const { pattern, label } of FORBIDDEN_TICS_ANYWHERE) {
    if (pattern.test(haystack)) hits.push(label);
  }
  // Closer-scoped: check last sentence of last paragraph AND the text hook.
  const lastSentence = getLastSentence(getLastParagraph(digestExtended));
  const hookSentence = getLastSentence(digestText);
  for (const { pattern, label } of FORBIDDEN_TICS_CLOSER) {
    if (pattern.test(lastSentence) || pattern.test(hookSentence)) hits.push(label);
  }
  return hits;
}
```

Integrate in `response.ts`:

```typescript
import { findForbiddenTics } from "./voice-guards";

// ... inside validateDigestModelOutput:
const tics = findForbiddenTics(parsed.digestText, parsed.digestExtended);
if (tics.length > 0) {
  issues.push({
    code: "forbidden-tic",
    severity: "soft",
    message: `Output contains house-style tic(s): ${tics.join(", ")}. Rewrite without them.`,
  });
}
```

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/voice-guards.ts worker/src/cron/daily-digest/response.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add forbidden-tic voice guard with closer-scoped 'worth watching'"
```

---

## Task 7: Voice guard — opening-sentence fingerprint

**Files:**
- Modify: `worker/src/cron/daily-digest/voice-guards.ts` (append)
- Modify: `worker/src/cron/daily-digest/response.ts` (integrate)
- Modify: `worker/src/cron/daily-digest/runtime-helpers.ts` — `RecentDigestMetaEntry` already exposes `rawText`; ensure callers pass the rawText when available (they do; no change needed there).
- Test: `daily-digest.test.ts`

**Why:** Recent digests overwhelmingly open with "PSI sits/slipped/ticked/held at X". The prompt says lead-from-candidate but the constraint is not programmatic. We fingerprint the opening (first head-word + verb class) and reject if the same fingerprint appears in 2 of the last 3 openings, OR if it is a `psi-verb` opening and any of the last 3 openings was also `psi-verb`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("opening-fingerprint voice guard", () => {
  function parsedFixture(extended: string) {
    return {
      digestTitle: "T", digestText: "T.", digestExtended: extended,
      digestMeta: JSON.stringify({ lead: "depeg", tone: "dry", coins: ["USDT"] }),
      strippedDashCount: 0, strippedForbiddenCharCount: 0, usedRawTextFallback: false,
    };
  }
  it("flags PSI-verb opening when any of last 3 also opened that way", () => {
    const recent = [
      { meta: null, title: "a", rawText: "PSI sits at 95. USDC hit ATH." },
      { meta: null, title: "b", rawText: "USDT minted $2B. PSI unchanged." },
      { meta: null, title: "c", rawText: "Flows rotated into gold. USDC weak." },
    ];
    const parsed = parsedFixture("PSI ticked to 96 in BEDROCK.\n\nUSDC added $500M.\n\nReal closer.");
    const issues = validateDigestModelOutput(parsed, { kind: "daily", recentMeta: recent });
    expect(issues.some((i) => i.code === "opening-pattern-repetition")).toBe(true);
  });
  it("does not flag when opening is structurally different", () => {
    const recent = [
      { meta: null, title: "a", rawText: "PSI sits at 95." },
      { meta: null, title: "b", rawText: "PSI slipped to 93." },
    ];
    const parsed = parsedFixture("USDT just added $2B overnight.\n\nPSI drifted to 93.\n\nReal closer.");
    const issues = validateDigestModelOutput(parsed, { kind: "daily", recentMeta: recent });
    expect(issues.some((i) => i.code === "opening-pattern-repetition")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Append to `voice-guards.ts`:

```typescript
const OPENING_PSI_VERBS = new Set([
  "sits", "sat", "slipped", "ticked", "held", "holds", "climbed", "climbs",
  "dropped", "drops", "fell", "falls", "reads", "read", "settles", "settled",
  "rises", "rose", "opened", "opens", "landed", "lands", "clawed", "claws",
  "extended", "extends", "hovers", "hovered", "gained", "gains",
  "clung", "clings", "edges", "edged", "tracks", "tracked",
]);

export function openingFingerprint(text: string): string | null {
  const firstSentence = text.trim().split(/[.!?\n]/)[0]?.trim() ?? "";
  if (!firstSentence) return null;
  const tokens = firstSentence.split(/\s+/).slice(0, 4);
  if (tokens.length < 2) return null;
  const head = tokens[0].replace(/[^A-Za-z]/g, "");
  const second = tokens[1].replace(/[^A-Za-z]/g, "").toLowerCase();
  if (head.toUpperCase() === "PSI" && OPENING_PSI_VERBS.has(second)) return "psi-verb";
  if (OPENING_PSI_VERBS.has(second)) return `${head.toUpperCase()}-verb`;
  return `${head.toUpperCase()}-${second}`;
}
```

In `response.ts`:

```typescript
import { openingFingerprint } from "./voice-guards";

// extend DigestValidationProfile.recentMeta[] to optionally include rawText
export interface DigestValidationProfile {
  kind: "daily" | "weekly";
  recentMeta?: Array<{
    meta: Record<string, unknown> | null;
    title: string | null;
    rawText?: string | null;
  }>;
}

// inside validateDigestModelOutput, after tic block:
const currentFingerprint = openingFingerprint(parsed.digestExtended);
if (currentFingerprint) {
  const recentFingerprints = recent
    .slice(0, 3)
    .map((entry) => {
      const source = entry.rawText ?? entry.title ?? "";
      return openingFingerprint(source);
    })
    .filter((fp): fp is string => !!fp);
  const matchCount = recentFingerprints.filter((fp) => fp === currentFingerprint).length;
  if (matchCount >= 2) {
    issues.push({
      code: "opening-pattern-repetition",
      severity: "soft",
      message: `Opening fingerprint '${currentFingerprint}' matches ${matchCount} of last 3 digests; open differently.`,
    });
  } else if (currentFingerprint === "psi-verb" && matchCount >= 1) {
    issues.push({
      code: "opening-pattern-repetition",
      severity: "soft",
      message: `PSI-verb opening repeats; the lead should surface a candidate fact first.`,
    });
  }
}
```

Update callers so `rawText` flows in. `buildRecentDigestMeta` in `runtime-helpers.ts` already produces `{meta, rawText, title}`. In `daily-digest.ts`, the profile builds `recentMeta` by mapping to `{meta, title}` only — add `rawText: entry.rawText`:

```typescript
// daily-digest.ts
validationProfile: {
  kind: "daily",
  recentMeta: recentMeta.map((entry) => ({
    meta: entry.meta as Record<string, unknown> | null,
    title: entry.title,
    rawText: entry.rawText,
  })),
},
```

Same pattern for weekly-recap.ts (already maps meta+title; just add rawText).

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/voice-guards.ts worker/src/cron/daily-digest/response.ts worker/src/cron/daily-digest.ts worker/src/cron/weekly-recap.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): reject repeated opening patterns via fingerprint check"
```

---

## Task 8: Voice guard — forward-look mandate

**Files:**
- Modify: `worker/src/cron/daily-digest/voice-guards.ts` (append)
- Modify: `worker/src/cron/daily-digest/response.ts` (integrate)
- Test: `daily-digest.test.ts`

**Why:** User explicit requirement: "help readers anticipate what is coming next." A simple regex-based detector looks for forward-look cues. Flag `missing-forward-look` (soft) if none is present. The daily/weekly prompt revisions (Tasks 13/14) mandate it explicitly, so retries should usually be unnecessary.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("forward-look voice guard", () => {
  function parsedFixture(extended: string, text = "T.") {
    return {
      digestTitle: "T", digestText: text, digestExtended: extended,
      digestMeta: JSON.stringify({ lead: "depeg", tone: "dry", coins: ["USDT"] }),
      strippedDashCount: 0, strippedForbiddenCharCount: 0, usedRawTextFallback: false,
    };
  }
  it("flags missing forward-look when digest is purely retrospective", () => {
    const result = validateDigestModelOutput(
      parsedFixture("USDT added $2B.\n\nUSDC pulled $500M.\n\nThe gap is now the story.", "USDT added $2B while USDC pulled $500M."),
      { kind: "daily", recentMeta: [] },
    );
    expect(result.some((i) => i.code === "missing-forward-look")).toBe(true);
  });
  it("does not flag when forward-look is present in extended", () => {
    const result = validateDigestModelOutput(
      parsedFixture("USDT added $2B.\n\nUSDC pulled $500M.\n\nIf the gap holds next week, it's a rotation."),
      { kind: "daily", recentMeta: [] },
    );
    expect(result.some((i) => i.code === "missing-forward-look")).toBe(false);
  });
  it("does not flag when forward-look is only in the text hook", () => {
    const result = validateDigestModelOutput(
      parsedFixture("A.\n\nB.\n\nC.", "Watch if USDT crosses $185B."),
      { kind: "daily", recentMeta: [] },
    );
    expect(result.some((i) => i.code === "missing-forward-look")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Append to `voice-guards.ts`:

```typescript
export const FORWARD_LOOK_CUES: RegExp[] = [
  /\bif\s+[\w$]+\s+(?:happens|holds|fails|breaks|crosses|stays|continues|keeps|slips|rises|falls|passes|drops)\b/i,
  /\bnext (?:session|day|digest|week|cycle|round|24h|48h|month)\b/i,
  /\bcoming (?:days?|week|month|session)\b/i,
  /\bwatch (?:for|the|if|when)\b/i,
  /\bto watch\b/i,
  /\btrigger\b/i,
  /\bthreshold\b/i,
  /\btip(?:s|ping)? over\b/i,
  /\bsnap (?:back|down)\b/i,
  /\b(?:will|could|should) (?:be|look|matter|decide|tell)\b/i,
  /\bnext (?:trigger|milestone|test|move)\b/i,
];

export function hasForwardLook(text: string): boolean {
  return FORWARD_LOOK_CUES.some((re) => re.test(text));
}
```

In `response.ts`:

```typescript
import { hasForwardLook } from "./voice-guards";

const forwardText = `${parsed.digestText}\n${parsed.digestExtended}`;
if (!hasForwardLook(forwardText)) {
  issues.push({
    code: "missing-forward-look",
    severity: "soft",
    message: "Digest lacks a forward-look cue (watch for…, if X happens…, next trigger…).",
  });
}
```

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/voice-guards.ts worker/src/cron/daily-digest/response.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): require a forward-look cue in every digest"
```

---

## Task 9: New data — chain-level mint/burn breakdown

**Files:**
- Modify: `shared/types/digest.ts` — extend `mintBurnFlows` with `topChains?: { chainId: string; netUsd: number }[]`
- Modify: `worker/src/cron/daily-digest/collectors-market.ts` — extend `collectMintBurnFlows` with chain aggregation
- Modify: `worker/src/cron/daily-digest/prompt.ts` — render chain block
- Test: `daily-digest.test.ts`

**Why:** Where money is flowing matters to readers. "USDT net +$200M on Tron, -$50M on Ethereum" is a story the current digest cannot tell. The existing `flow24hRows` already groups by `chain_id`; the aggregation is a one-pass reduce.

**Naming note:** We keep `chainId` (no `chainName`). Chain IDs are already human-legible tokens like `ethereum`, `tron`, `arbitrum`. The LLM renders them with proper casing.

- [ ] **Step 1: Write the failing test**

```typescript
// daily-digest.test.ts — extend the mint-burn test
const storedInput = JSON.parse(String(insertBinds?.[3]));
expect(storedInput.mintBurnFlows.topChains).toBeDefined();
expect(Array.isArray(storedInput.mintBurnFlows.topChains)).toBe(true);
expect(storedInput.mintBurnFlows.topChains.length).toBeLessThanOrEqual(3);
expect(storedInput.mintBurnFlows.topChains[0]).toMatchObject({ chainId: expect.any(String), netUsd: expect.any(Number) });
// ordered by |netUsd| desc
expect(Math.abs(storedInput.mintBurnFlows.topChains[0].netUsd))
  .toBeGreaterThanOrEqual(Math.abs(storedInput.mintBurnFlows.topChains[storedInput.mintBurnFlows.topChains.length - 1].netUsd));
```

Plus a prompt assertion in happy-path:

```typescript
expect(body.messages[0].content).toContain("Top chains by net flow");
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Extend shared type:

```typescript
// shared/types/digest.ts — inside mintBurnFlows
mintBurnFlows?: {
  gaugeScore: number;
  gaugeBand: string;
  flightToQuality: { active: boolean; safeNetUsd: number; riskyNetUsd: number; };
  topPressure: { symbol: string; intensity: number; net24hUsd: number; }[];
  topChains?: { chainId: string; netUsd: number; }[];
};
```

Compute in `collectMintBurnFlows` (add before the return):

```typescript
const chainTotals = new Map<string, number>();
for (const row of flow24hRows.results ?? []) {
  if (!isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)) continue;
  chainTotals.set(row.chain_id, (chainTotals.get(row.chain_id) ?? 0) + row.net_24h);
}
const topChains = [...chainTotals.entries()]
  .map(([chainId, netUsd]) => ({ chainId, netUsd }))
  .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))
  .slice(0, 3);

return {
  gaugeScore,
  gaugeBand: getGaugeBand(gaugeScore).label,
  flightToQuality: { active: ftq.active, safeNetUsd: safeNet24h, riskyNetUsd: riskyNet24h },
  topPressure,
  topChains,
};
```

Render in prompt:

```typescript
// in prompt.ts, inside the mintBurnFlows block
if (data.mintBurnFlows.topChains && data.mintBurnFlows.topChains.length > 0) {
  lines.push("  Top chains by net flow:");
  for (const chain of data.mintBurnFlows.topChains) {
    lines.push(`    ${chain.chainId}: ${chain.netUsd >= 0 ? "+" : ""}${formatCurrency(chain.netUsd)} net`);
  }
}
```

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors-market.ts worker/src/cron/daily-digest/prompt.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add chain-level mint/burn breakdown to daily input"
```

---

## Task 10: New data — `totalMcapAth` context

**Files:**
- Modify: `shared/types/digest.ts` — add `totalMcapAth?: { value: number; date: number; daysAgo: number }`
- Add: `collectTotalMcapAth` in `worker/src/cron/daily-digest/collectors-history.ts`
- Modify: `worker/src/cron/daily-digest/collectors.ts` — re-export
- Modify: `worker/src/cron/daily-digest/input.ts` — wire
- Modify: `worker/src/cron/daily-digest/prompt.ts` — render
- Test: `daily-digest.test.ts`

**Why:** The total stablecoin mcap is a moving number. Readers only feel "up 0.6% this week" once they also see "now at $330B, 1% below its $333B ATH 18 days ago." Existing supply-mover ATH is coin-level only.

**Reviewer-fix:** The previous SQL used `MAX(...) ... generated_at` without GROUP BY, which is undefined in SQLite. Correct form: select the column + timestamp, order by column desc, limit 1.

- [ ] **Step 1: Write the failing test**

```typescript
describe("totalMcapAth enrichment", () => {
  it("records ATH context when supplied", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseTables = makeBaseTables();
    const db = mockD1([
      ...baseTables,
      {
        match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC",
        first: { ath_value: 330_000_000_000, ath_date: nowSec - 7 * 86_400 },
        rows: [],
      },
    ]);
    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);
    const storedInput = JSON.parse(String(getInsertDigestBinds(db as MockD1Database)?.[3]));
    expect(storedInput.totalMcapAth).toBeDefined();
    expect(storedInput.totalMcapAth.value).toBe(330_000_000_000);
    expect(storedInput.totalMcapAth.daysAgo).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Add to shared types:

```typescript
// shared/types/digest.ts — top-level of DigestInputData
totalMcapAth?: { value: number; date: number; daysAgo: number };
```

Add collector:

```typescript
// worker/src/cron/daily-digest/collectors-history.ts
export async function collectTotalMcapAth(ctx: CollectorContext): Promise<DigestInputData["totalMcapAth"]> {
  try {
    const row = await ctx.db
      .prepare(
        `SELECT CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) as ath_value, generated_at as ath_date
         FROM daily_digest
         WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER})
           AND json_extract(input_data, '$.totalMcapUsd') IS NOT NULL
         ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC
         LIMIT 1`,
      )
      .first<{ ath_value: number | null; ath_date: number | null }>();
    if (!row || row.ath_value == null || row.ath_date == null || row.ath_value <= 0) return undefined;
    const dayTs = row.ath_date - (row.ath_date % SECONDS.ONE_DAY);
    return {
      value: row.ath_value,
      date: dayTs,
      daysAgo: Math.max(0, Math.round((ctx.todayTs - dayTs) / SECONDS.ONE_DAY)),
    };
  } catch (error) {
    console.error("[daily-digest] Failed to collect total mcap ATH:", error);
    return undefined;
  }
}
```

Add to `collectors.ts` exports; call from `input.ts` and set on `inputData.totalMcapAth`.

Render in `prompt.ts`, right after the Total mcap line:

```typescript
if (data.totalMcapAth && data.totalMcapAth.value > 0) {
  const pctFromAth = ((data.totalMcapAth.value - data.totalMcapUsd) / data.totalMcapAth.value * 100).toFixed(2);
  const relation = data.totalMcapUsd < data.totalMcapAth.value ? "below" : "above";
  lines.push(
    `Context: total mcap is ${pctFromAth}% ${relation} its Digest-window ATH (${formatCurrency(data.totalMcapAth.value)} set ${data.totalMcapAth.daysAgo} days ago).`,
  );
}
```

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors-history.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest/input.ts worker/src/cron/daily-digest/prompt.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add total mcap ATH context to daily prompt"
```

---

## Task 11: Momentum Candidates block in prompt (novelty-driven forward-watch)

**Files:**
- Modify: `worker/src/cron/daily-digest/editorial-candidates.ts` — export `selectMomentumCandidates(candidates)` helper
- Modify: `worker/src/cron/daily-digest/prompt.ts` — render a `Momentum Candidates (forward-watch material)` block
- Test: `daily-digest.test.ts`

**Why:** The editorial-candidate layer already assigns `novelty` (`new`, `worsening`, `improving`, `reversal`, `accelerating`, `decelerating`, `recurring`, `chronic`, `structural`). The forward-look validator in Task 8 is reactive (checks the output for a regex cue). A proactive upstream surface is cheaper: list candidates whose novelty is momentum-oriented (`new`, `accelerating`, `reversal`) so the prompt can say "this is the anticipatory material" and the model has concrete factual anchors for the forward-look line.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("momentum candidates surface", () => {
  it("renders Momentum Candidates block listing new/accelerating/reversal", async () => {
    const db = mockD1(makeBaseTables());
    const result = await generateDailyDigest(db, "anthropic-key");
    expect(result.itemCount).toBe(1);
    const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain("Momentum Candidates");
  });
});
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

Add helper in `editorial-candidates.ts`:

```typescript
export function selectMomentumCandidates(candidates: DigestEditorialCandidate[]): DigestEditorialCandidate[] {
  const momentum = new Set<DigestEditorialCandidateNovelty>(["new", "accelerating", "reversal"]);
  return candidates
    .filter((c) => !c.suppressReason && c.artifactRisk !== "high" && momentum.has(c.novelty))
    .slice(0, 4);
}
```

Render in `prompt.ts`, inside `pushEditorialCandidateLines` after the main candidate list:

```typescript
import { selectMomentumCandidates } from "./editorial-candidates";

function pushMomentumLines(lines: string[], data: DigestInputData): void {
  const candidates = data.editorialCandidates ?? [];
  const momentum = selectMomentumCandidates(candidates);
  if (momentum.length === 0) return;
  lines.push("", "Momentum Candidates (forward-watch material — use these to anchor the required forward-look line):");
  for (const candidate of momentum) {
    const symbols = candidate.symbols.length > 0 ? ` | coins=${candidate.symbols.join(",")}` : "";
    lines.push(`  ${candidate.id} | ${candidate.kind}/${candidate.novelty}${symbols} | impact=${candidate.impactScore}`);
    lines.push(`    why it may keep moving: ${candidate.whyItMatters}`);
  }
}

// and call pushMomentumLines(lines, data) from buildUserPrompt right after pushEditorialCandidateLines
```

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/editorial-candidates.ts worker/src/cron/daily-digest/prompt.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): surface Momentum Candidates (novelty-driven forward-watch block)"
```

---

## Task 12: New data — weekly week-over-week deltas

**Files:**
- Modify: `shared/types/digest.ts` — add `WeeklyInputData.weekOverWeekDeltas?` (optional in existing WeeklyInputData if exported; currently weekly uses a local type in `weekly-recap.ts`)
- Modify: `worker/src/cron/weekly-recap.ts` — extend `WeeklyInputData`, rewrite `buildWeeklyInputData` signature `(currentRows, priorRows)`, compute deltas, render in `buildWeeklyPrompt`, bump query cutoff to -15d and add `LIMIT 15`
- Test: `weekly-recap.test.ts`

**Why:** User asked for "help readers anticipate what is coming next." Week-over-week context is the second most powerful anticipatory frame after individual momentum candidates. The prior-week aggregate is derivable from daily-digest rows 8–14 behind the current run.

**Reviewer-fix 1:** The existing `.slice(-7)` implicitly assumes result ordering but lacks a hard `LIMIT`. If the `-8d` cutoff drifts, you get 15+ rows. We add `LIMIT 15` to the SQL and split with explicit timestamp math rather than positional slicing.

**Reviewer-fix 2 (field-name harmonization):** Use consistent `{current, prior, delta}` shape across all fields.

**Shape:**

```typescript
weekOverWeekDeltas: {
  mcap: { current: number; prior: number; deltaPct: number | null };
  psi: { current: number; prior: number; delta: number };
  psiDominantBand: { current: string; prior: string };
  activeDepegObservations: { current: number; prior: number };
  uniqueDepegSignals: { current: number; prior: number };
  blacklistEvents: { current: number; prior: number };
  blacklistUsd: { current: number; prior: number };
  gradeTransitions: { current: number; prior: number };
  gauge: { current: number | null; prior: number | null };
  dataCoverage: { currentDays: number; priorDays: number };
} | null;
```

- [ ] **Step 1: Write the failing test**

```typescript
it("includes week-over-week deltas in prompt when prior week data exists", async () => {
  const current = buildDailyRows();
  const prior = buildDailyRows().map((row, i) => ({
    ...row,
    generated_at: row.generated_at - 7 * 86_400,
    input_data: JSON.stringify({
      ...(JSON.parse(row.input_data) as Record<string, unknown>),
      totalMcapUsd: 99_000_000 + i * 1_000_000,
      stabilityIndex: { score: 92 - i, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    }),
  }));
  const db = mockD1([
    {
      match: "SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'",
      first: null, rows: [],
    },
    { match: "SELECT digest_title, digest_text, digest_meta", rows: [] },
    // Note: the cutoff is now -15d and ORDER BY ASC LIMIT 15
    {
      match: "WHERE generated_at >= ? AND (digest_meta IS NULL",
      rows: [...prior, ...current],
    },
    { match: "INSERT INTO daily_digest", rows: [] },
  ]);
  vi.mocked(fetchWithRetry).mockResolvedValueOnce(weeklyClaudeResponse());
  await generateWeeklyRecap(db, "anthropic-key", null);
  const body = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as { messages: { content: string }[] };
  expect(body.messages[0].content).toContain("Week-over-week deltas");
  expect(body.messages[0].content).toMatch(/mcap: current .+ prior .+ delta/i);
  expect(body.messages[0].content).toMatch(/PSI midpoint: current .+ prior .+/i);
});
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

In `weekly-recap.ts`:

```typescript
// extend WeeklyInputData with weekOverWeekDeltas (optional, shape above)

// adjust the SQL cutoff + LIMIT
const cutoff = Math.floor(Date.now() / 1000) - 15 * SECONDS.ONE_DAY;
const dailyRows = await db
  .prepare(
    `SELECT generated_at, digest_title, digest_text, digest_extended, input_data
     FROM daily_digest
     WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
     ORDER BY generated_at ASC
     LIMIT 15`,
  )
  .bind(cutoff)
  .all<{ generated_at: number; digest_title: string | null; digest_text: string; digest_extended: string | null; input_data: string }>();

const allRows = dailyRows.results ?? [];
// Split on a UTC day boundary (not a rolling 7d wall-clock window).
// The cron runs Monday 08:05 UTC; each daily digest is generated at
// 08:05 UTC of its own day. If we split at `now - 7d` the boundary lands
// at ~08:05 last Monday, which is within a few seconds of last Monday's
// daily-digest timestamp — drift of a few seconds across weeks can flip
// that row between current and prior. Snap to 00:00 UTC of "last Tuesday"
// (= todayTs - 6d) so the split is unambiguous at the day level.
const nowSec = Math.floor(Date.now() / 1000);
const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
const weekBoundary = todayTs - 6 * SECONDS.ONE_DAY;
const currentRows = allRows.filter((r) => r.generated_at >= weekBoundary);
const priorRows = allRows.filter((r) => r.generated_at < weekBoundary);

if (currentRows.length < 5) {
  return { metadata: `skipped: only ${currentRows.length} daily digests available in current week (need 5+)` };
}

const weeklyData = buildWeeklyInputData(currentRows, priorRows);
```

Modify `buildWeeklyInputData(currentRows, priorRows)`:
1. Run the existing aggregation over `currentRows` as today.
2. If `priorRows.length >= 5`, run a trimmed-down aggregation over `priorRows` (just totals, no leaderboards) and diff.
3. If `priorRows.length < 5`, set `weekOverWeekDeltas = null` on the returned object.

Factor the aggregation into a helper:

```typescript
function aggregateBasics(parsed: { inputData: DigestInputData; date: string }[]): {
  mcapEnd: number; psiMid: number; psiDominantBand: string;
  activeDepegObs: number; uniqueDepegSignals: number;
  blacklistEvents: number; blacklistUsd: number;
  gradeTransitions: number; gaugeMid: number | null; days: number;
} {
  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const mcaps = parsed.map((d) => d.inputData.totalMcapUsd);
  const psiBands = parsed.map((d) => d.inputData.stabilityIndex?.band).filter((b): b is string => b != null);
  const bandFreq = new Map<string, number>();
  for (const b of psiBands) bandFreq.set(b, (bandFreq.get(b) ?? 0) + 1);
  const psiDominantBand = [...bandFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "BEDROCK";
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);
  const depegObs = parsed.reduce((sum, d) => sum + d.inputData.activeDepegCount, 0);
  const depegKeys = new Set<string>();
  for (const d of parsed) {
    for (const depeg of d.inputData.topDepegs ?? []) {
      depegKeys.add(depeg.startedAt != null
        ? `${depeg.stablecoinId ?? depeg.symbol}:${depeg.startedAt}:active`
        : `${depeg.symbol}:${depeg.direction ?? ""}:${depeg.bps}:active`);
    }
    for (const depeg of d.inputData.resolvedDepegs ?? []) {
      depegKeys.add(depeg.startedAt != null
        ? `${depeg.stablecoinId ?? depeg.symbol}:${depeg.startedAt}:resolved`
        : `${depeg.symbol}:${depeg.direction ?? ""}:${depeg.peakBps}:resolved`);
    }
  }
  return {
    mcapEnd: mcaps[mcaps.length - 1] ?? 0,
    psiMid: psiScores.length > 0 ? psiScores.reduce((s, v) => s + v, 0) / psiScores.length : 0,
    psiDominantBand,
    activeDepegObs: depegObs,
    uniqueDepegSignals: depegKeys.size,
    blacklistEvents: parsed.reduce((s, d) => s + (d.inputData.blacklistActivity?.eventCount ?? 0), 0),
    blacklistUsd: parsed.reduce((s, d) => s + (d.inputData.blacklistActivity?.totalAmountUsd ?? 0), 0),
    gradeTransitions: parsed.reduce((s, d) => s + (d.inputData.gradeTransitions?.length ?? 0), 0),
    gaugeMid: gauges.length >= 3 ? gauges.reduce((s, v) => s + v, 0) / gauges.length : null,
    days: parsed.length,
  };
}
```

In `buildWeeklyInputData`, call `aggregateBasics` for current and prior, then:

```typescript
let weekOverWeekDeltas: WeeklyInputData["weekOverWeekDeltas"] = null;
if (priorParsed.length >= 5) {
  const cur = aggregateBasics(parsed);
  const pri = aggregateBasics(priorParsed);
  weekOverWeekDeltas = {
    mcap: {
      current: cur.mcapEnd, prior: pri.mcapEnd,
      deltaPct: pri.mcapEnd > 0 ? ((cur.mcapEnd - pri.mcapEnd) / pri.mcapEnd) * 100 : null,
    },
    psi: { current: cur.psiMid, prior: pri.psiMid, delta: cur.psiMid - pri.psiMid },
    psiDominantBand: { current: cur.psiDominantBand, prior: pri.psiDominantBand },
    activeDepegObservations: { current: cur.activeDepegObs, prior: pri.activeDepegObs },
    uniqueDepegSignals: { current: cur.uniqueDepegSignals, prior: pri.uniqueDepegSignals },
    blacklistEvents: { current: cur.blacklistEvents, prior: pri.blacklistEvents },
    blacklistUsd: { current: cur.blacklistUsd, prior: pri.blacklistUsd },
    gradeTransitions: { current: cur.gradeTransitions, prior: pri.gradeTransitions },
    gauge: { current: cur.gaugeMid, prior: pri.gaugeMid },
    dataCoverage: { currentDays: cur.days, priorDays: pri.days },
  };
}
```

Render in `buildWeeklyPrompt`:

```typescript
if (data.weekOverWeekDeltas) {
  const d = data.weekOverWeekDeltas;
  lines.push("", "Week-over-week deltas (this week vs prior week):");
  lines.push(`  mcap: current ${formatCurrency(d.mcap.current)} / prior ${formatCurrency(d.mcap.prior)} / delta ${d.mcap.deltaPct == null ? "n/a" : `${d.mcap.deltaPct >= 0 ? "+" : ""}${d.mcap.deltaPct.toFixed(2)}%`}`);
  lines.push(`  PSI midpoint: current ${d.psi.current.toFixed(1)} / prior ${d.psi.prior.toFixed(1)} / delta ${d.psi.delta >= 0 ? "+" : ""}${d.psi.delta.toFixed(1)}`);
  lines.push(`  PSI dominant band: current ${d.psiDominantBand.current} / prior ${d.psiDominantBand.prior}`);
  lines.push(`  Active depeg observations: current ${d.activeDepegObservations.current} / prior ${d.activeDepegObservations.prior}`);
  lines.push(`  Unique depeg signals: current ${d.uniqueDepegSignals.current} / prior ${d.uniqueDepegSignals.prior}`);
  lines.push(`  Blacklist events: current ${d.blacklistEvents.current} / prior ${d.blacklistEvents.prior}`);
  lines.push(`  Blacklist USD: current ${formatCurrency(d.blacklistUsd.current)} / prior ${formatCurrency(d.blacklistUsd.prior)}`);
  lines.push(`  Grade transitions: current ${d.gradeTransitions.current} / prior ${d.gradeTransitions.prior}`);
  if (d.gauge.current != null && d.gauge.prior != null) {
    lines.push(`  Bank Run Gauge midpoint: current ${d.gauge.current.toFixed(1)} / prior ${d.gauge.prior.toFixed(1)}`);
  }
  lines.push(`  Data coverage: ${d.dataCoverage.currentDays}d current, ${d.dataCoverage.priorDays}d prior`);
} else {
  lines.push("", "Week-over-week deltas: unavailable (insufficient prior-week history).");
}
```

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/weekly-recap.ts worker/src/cron/__tests__/weekly-recap.test.ts shared/types/digest.ts
git commit -m "feat(digest): add week-over-week delta block to weekly recap"
```

---

## Task 13: Daily prompt rewrite (with few-shot exemplar)

**Files:**
- Modify: `worker/src/cron/daily-digest/prompt.ts:13-101` (SYSTEM_PROMPT)
- Tests: daily-digest.test.ts — assert new prompt substrings

**Why:** Consolidate the opening rule, forward-look mandate, spice budget, tic list, expanded enums, and the new Momentum / chain / ATH data references into a single rewritten prompt. Add a compact ~130-word exemplar digest so voice is anchored by example, not only by rules.

**Reviewer insight:** One well-chosen exemplar does more for voice than 30 lines of rules. The exemplar must demonstrate: (a) open from a candidate fact (not PSI-verb), (b) one sharp sentence, (c) one forward-look line, (d) no forbidden tics.

- [ ] **Step 1: Write the failing tests**

```typescript
// daily-digest.test.ts — happy-path assertions
const systemPrompt = body.system;
expect(systemPrompt).toContain("Do NOT reuse any of the following house-style tics");
expect(systemPrompt).toContain("plumbing");
expect(systemPrompt).toContain("forward-look");
expect(systemPrompt).toContain("Earn one sharp sentence");
expect(systemPrompt).toContain("EXEMPLAR");
expect(systemPrompt).toContain("Momentum Candidates");
expect(systemPrompt).toContain("total mcap is");
```

- [ ] **Step 2: Run tests to verify fail** — expect FAIL.

- [ ] **Step 3: Implement — rewrite `SYSTEM_PROMPT`**

Replace the existing `SYSTEM_PROMPT` with the following (joined by newlines):

```typescript
export const SYSTEM_PROMPT = [
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard.",
  "Your voice is dry, sharp, and memorable, like a financial columnist who has seen too many death spirals to be impressed.",
  "Sardonic wit meets hard data. Humor earns its place through precision, not clowning.",
  "",
  "SELECTION FIRST. STYLE SECOND.",
  "Lead from the highest-impact unsuppressed Editorial Candidate (provided before the raw evidence). Raw evidence is supporting material.",
  "Do not lead with a candidate marked suppressReason, artifactRisk=high, chronic, stale, zero-dollar, or first-day/no-baseline, unless all larger candidates are explicitly worse.",
  "For yield and liquidity, require corroboration from TVL, flows, DEWS, or market cap before making them the lead.",
  "Rank by market impact: deviation times market cap for depegs, absolute net flow for supply, affected mcap for DEWS.",
  "Reference Momentum Candidates when building the forward-look line; those are the signals most likely to keep moving.",
  "",
  "OPENING RULE.",
  "The first sentence of the extended field must surface a fact drawn from the lead candidate (a coin name, a number, a specific change).",
  "Do NOT open with 'PSI sits/slipped/ticked/held/climbed' two digests in a row. If yesterday opened that way, open from the lead candidate's subject.",
  "PSI must still appear as a regime frame somewhere in the digest, but it is rarely the protagonist.",
  "",
  "REGIME AWARENESS.",
  "Four regimes (CRISIS, TENSION, WATCHFUL, CALM) set register and paragraph count:",
  "- CRISIS: 3-4 paragraphs, urgent and precise. Lead with the breaking event. PSI frames P2 or P3.",
  "- TENSION: 3-4 paragraphs, foreboding and sharp. Lead with what is building.",
  "- WATCHFUL: 3 paragraphs, observant and dry. Lead with the sharpest signal, even small.",
  "- CALM: 3 paragraphs. Find the story in the stillness. Say the market is calm when it is. Do not manufacture menace.",
  "Tone defaults are suggestions. Override when the data calls for a different register.",
  "",
  "FORWARD-LOOK MANDATE.",
  "Every digest must contain at least one forward-look line in the extended field or text hook.",
  "Acceptable forms: 'If X crosses/fails/holds next Y, it signals Z', 'Watch for W next session', 'Next trigger: Q', 'Will decide whether R'.",
  "Ground it in a Momentum Candidate when possible. Retrospectives without an anticipatory line are rejected.",
  "",
  "SPICE BUDGET.",
  "Earn one sharp sentence per digest: a named analogy, a historical parallel, a concrete-stakes observation, or a precise ironic contrast.",
  "One per digest, not every paragraph. Do not force it; if nothing earns it, skip it.",
  "",
  "DENSITY AND STRUCTURE.",
  "Each paragraph is 40-70 words. Total extended: 150-280 words. Default 3 paragraphs; write 4 only when a distinct secondary story cannot fold into 1-3.",
  "Every sentence must contain a specific number, coin name, or sharp observation.",
  "No throat-clearing ('Meanwhile', 'In other news', 'It's worth noting', 'It remains to be seen').",
  "No hedging qualifiers ('somewhat', 'arguably', 'perhaps', 'it remains to be seen').",
  "If a sentence does not carry data or wit, cut it.",
  "",
  "VARIETY IS MANDATORY.",
  "Recent digest angles (lead, tone, coins) are provided below. Do NOT repeat the same lead family, tone, or primary coin as any of the last 3 days.",
  "Same numbers can tell different stories. Rotate leads, tones, featured coins deliberately.",
  "If tone 'foreboding' has appeared 3 or more times in the last 5 digests, choose any tone other than foreboding even if the data feels ominous.",
  "",
  "FORBIDDEN TICS.",
  "Do NOT reuse any of the following house-style tics or their close variants:",
  "- 'plumbing' (as metaphor), 'beneath the calm', 'beneath the bedrock', 'restless depths', 'restless plumbing'",
  "- 'calm surfaces,' or 'surface calm' as opener or closer",
  "- 'something is moving underneath/beneath'",
  "- 'the plumbing flinched', 'the plumbing said otherwise', 'the plumbing is ...'",
  "- 'serene' describing the market",
  "- 'worth watching', 'worth monitoring', 'bears watching' as a closer in the final sentence of the extended field or the text hook",
  "- 'time will tell', 'the question is whether', 'it is worth asking whether'",
  "These are tics, not style. If your draft contains any of them, rewrite the sentence.",
  "",
  "FORMATTING.",
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods. Any dash that is not a hyphen is forbidden.",
  "No emojis, no clickbait, no exclamation marks, no markdown code fences.",
  "Optional section headers (bold inline, 2-4 words) for distinct secondary stories. P1 never takes a header. Use only when two stories are genuinely distinct.",
  "",
  "HISTORICAL CONTEXT.",
  "'Context:' lines after PSI and supply data provide streaks, precedents, and ATH comparisons. USE THEM.",
  "'PSI at 72' is a data point. 'PSI at 72, its lowest since March' is journalism.",
  "A total-mcap ATH context line may also appear near the top of supporting evidence; weave it in when the proximity is material.",
  "PSI historical comparisons are scoped to the Digest tracking window. NEVER write 'all-time low' or 'lowest ever' for PSI; write 'lowest since the Digest began' or 'lowest in N days of tracking'.",
  "",
  "OUTPUT CONTRACT.",
  "Respond with valid JSON only. No markdown fences, no preamble, no trailing text.",
  '{ "title": "2-6 word headline", "extended": "...", "text": "tweet-sized hook under 270 chars combined with title", ',
  '  "meta": { "leadSignalId": "candidate id", "lead": "one of allowed leads", "tone": "one of allowed tones", "coins": ["TOP","COINS"], "usedCandidateIds": [], "suppressedCandidateIds": [] } }',
  "Allowed leads: psi-streak, psi-regime, psi-band-change, psi-divergence, depeg, resolved-depeg, chronic-depeg, dews-band-change, dews-alert-breadth, dews-warning, ftq, mint-burn, gauge-flip, gauge-divergence, supply-reversal, supply-acceleration, supply-deceleration, chain-migration, grade-transition, blacklist-contrast, reserve-event, yield-anomaly, liquidity-shift, macro-observation, market-structure, issuer-concentration, regime-divergence, other.",
  "Allowed tones: bemused, foreboding, clinical, wistful, darkly-amused, urgent, dry, analytical, calm, skeptical, sardonic, observant, forensic, resigned, ironic, other.",
  "Text field (hook) rules: lead with the sharpest number or most provocative observation. Do not start with the title (prepended automatically). Combined 'title + text' must be under 270 characters.",
  "",
  "EXEMPLAR (structural pattern only: open from a candidate fact, develop with numbers, name one sharp asymmetry, close with a forward-look line. DO NOT copy phrases verbatim; the exemplar's metaphors are intentionally spare to discourage imitation).",
  "Title: USDC Laps Its Own Shadow",
  "Text: USDC printed $80B and shed $202M in the same session; the split will matter more next week than the milestone did today.",
  "Extended:",
  "USDC pushed through $80B for the first time on a day it also lost $202M in net flows after 16:00 UTC. The $80B line was set in December and has held as resistance for four months; Circle took that long to build the runway to test it. USDT held flat at $185B, which for the dominant issuer is itself a data point, not an absence of one.",
  "",
  "DEWS moved GHO from WATCH to ALERT on liquidity erosion, and YLDS shed 44% of DEX depth on a $577M float. A top-20 peg scraping ATH while a mid-cap quietly loses exit capacity is the asymmetry that deserves the reader's attention, not the headline milestone.",
  "",
  "Next watch: whether USDC holds above $79.8B at the 08:00 UTC snapshot, and whether GHO's liquidity score recovers from 62 before Thursday.",
  "Meta: { \"leadSignalId\": \"market:usdc-circle:weekly-supply\", \"lead\": \"market-structure\", \"tone\": \"observant\", \"coins\": [\"USDC\",\"GHO\"], \"usedCandidateIds\": [\"market:usdc-circle:weekly-supply\",\"dews:gho:watch-alert\"] }",
].join("\n");
```

- [ ] **Step 4: Run tests to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/prompt.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): rewrite daily system prompt with opening rule, tic list, forward-look, spice budget, exemplar"
```

---

## Task 14: Weekly prompt rewrite

**Files:**
- Modify: `worker/src/cron/weekly-recap.ts` — WEEKLY_SYSTEM_PROMPT
- Test: `weekly-recap.test.ts`

**Why:** Parity with daily: mandate forward-look, list tics, reference the WoW deltas block explicitly, tighten arc framing.

- [ ] **Step 1: Write the failing test**

```typescript
// weekly-recap.test.ts — happy-path assertions
const weeklySystem = weeklyBody.system as string;
expect(weeklySystem).toContain("forward-look");
expect(weeklySystem).toContain("plumbing");
expect(weeklySystem).toContain("week-over-week");
expect(weeklySystem).toContain("arc");
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement**

```typescript
const WEEKLY_SYSTEM_PROMPT = [
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard.",
  "Dry, sharp, memorable, like a sardonic columnist synthesizing rather than reporting.",
  "",
  "You receive a week of daily digest data, pre-aggregated weekly signal leaderboards, and week-over-week delta summaries.",
  "Use the Weekly Signals block as the source of truth for the week's protagonists. Use the week-over-week deltas to frame where this week sits versus the previous one.",
  "Daily headlines show how the week felt in sequence; the signal leaderboard and deltas decide what mattered.",
  "",
  "ARC FRAMING.",
  "Find the week's narrative arc: what started, what ended, what is building.",
  "A weekly recap that reads like seven daily digests stapled together has failed.",
  "Do not turn seven observations of the same chronic active depeg into seven events. Separate active observations from unique signals.",
  "Do not dramatize suppressed, stale, zero-dollar, tiny, or artifact-prone signals. If the week was genuinely calm, say so clearly.",
  "",
  "FORWARD-LOOK MANDATE.",
  "The last paragraph must contain an anticipatory sentence about next week. Acceptable: 'next week will decide whether X', 'watch the Y threshold if Z continues', 'the next trigger is W crossing V'.",
  "Retrospective-only recaps are rejected.",
  "",
  "SPICE BUDGET.",
  "Earn one sharp sentence per recap: a named analogy, a historical parallel, or a concrete-stakes observation.",
  "One per recap. Do not force it.",
  "",
  "FORBIDDEN TICS.",
  "Do NOT reuse: 'plumbing' (as metaphor), 'beneath the calm', 'restless depths', 'calm surfaces,', 'surface calm', 'something moving underneath', 'serene', 'worth watching/monitoring' or 'bears watching' as a closer, 'time will tell', 'the question is whether', 'it is worth asking whether'.",
  "",
  "FORMATTING.",
  "No emojis, no clickbait, no hedging, no exclamation marks.",
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods.",
  "",
  "STRUCTURE.",
  "The extended field is 4-6 paragraphs, 250-400 words total.",
  "P1: the week's headline, what defined it, PSI arc and dominant regime.",
  "P2: the dominant story, the thread that ran through multiple days.",
  "P3: the counter-narrative, what moved the opposite direction or was quietly significant.",
  "P4: supply and capital flows, weekly mcap movement, biggest movers, gauge trend, referring to week-over-week deltas when they change the story.",
  "P5-P6 (optional): a structural observation or the forward-look.",
  "If using fewer than 6 paragraphs, fold the forward-look into the last paragraph.",
  "",
  "Every sentence must contain a specific number or coin name. Reference individual daily headlines when they illustrate a point.",
  "",
  "OUTPUT CONTRACT.",
  'Respond with valid JSON only: { "title": "3-8 word headline", "extended": "...", "text": "tweet-sized hook under 270 chars combined with title", ',
  '  "meta": { "leadSignalId": "...", "lead": "one of allowed leads", "tone": "one of allowed tones", "coins": ["..."], "usedCandidateIds": [...] } }',
  "Allowed leads and tones are identical to the daily contract.",
].join("\n");
```

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/weekly-recap.ts worker/src/cron/__tests__/weekly-recap.test.ts
git commit -m "feat(digest): rewrite weekly prompt with arc, forward-look, tic list, WoW reference"
```

---

## Task 15: Drop `safetyScores.distribution` aggregates from prompt surface

**Files:**
- Modify: `worker/src/cron/daily-digest/prompt.ts` — drop the distribution line only
- Test: `daily-digest.test.ts`

**Why:** The aggregate line is almost never cited in output. The frontend (`src/components/digest-snapshot.tsx:267-269`) continues to read these fields from the stored `input_data`, so the collector stays intact — only the prompt string changes.

- [ ] **Step 1: Write the failing test**

```typescript
// daily-digest.test.ts happy path
expect(body.messages[0].content).not.toContain("Distribution: median");
expect(body.messages[0].content).not.toMatch(/\d+ above B/);
```

- [ ] **Step 2: Run test to verify fail** — expect FAIL.

- [ ] **Step 3: Implement — remove just the distribution line**

```typescript
// worker/src/cron/daily-digest/prompt.ts — delete this line from the safetyScores block:
// lines.push(`  Distribution: median ${medianGrade}, ${aboveBCount} above B, ${fCount} rated F`);
```

The collector continues to produce `safetyScores.medianGrade`, `.aboveBCount`, `.fCount`. The stored `input_data` still has them. The frontend detail card still renders them. Only the LLM prompt drops them.

- [ ] **Step 4: Run test to verify pass** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/daily-digest/prompt.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "simplify(digest): drop safety distribution aggregates from prompt surface"
```

---

## Task 16: Weekly meta normalization verification (lock-in test)

**Files:**
- Test-only: `worker/src/cron/__tests__/weekly-recap.test.ts`
- Code fix to `worker/src/cron/weekly-recap.ts` only if the test fails

**Why:** Historical weekly rows in D1 store `lead` as full English sentences — evidence of a pre-2026-04-15 path that bypassed normalization. The post-2026-04-15 code should normalize weekly meta identically to daily. This is a verification test to lock in the invariant, not a TDD-first drive for new behavior.

- [ ] **Step 1: Write the verification test**

```typescript
it("normalizes weekly meta lead and tone through the allowlist", async () => {
  const db = mockD1(makeTables());
  vi.mocked(fetchWithRetry).mockResolvedValueOnce(weeklyClaudeResponse({
    meta: {
      leadSignalId: "wk:arc",
      lead: "Week narrative about USDC flow rotation accelerating mid-week",
      tone: "structurally-concerned-sardonic",
      coins: ["USDC"],
    },
  }));
  await generateWeeklyRecap(db, "anthropic-key", null);
  const insertCall = db.getHistory().find((e) => e.sql.includes("INSERT INTO daily_digest"));
  const metaStored = JSON.parse(String(insertCall?.binds?.[5]));
  expect(metaStored.lead).toBe("other");
  expect(metaStored.tone).toBe("other");
  expect(metaStored.type).toBe("weekly");
});
```

- [ ] **Step 2: Run the test**

```
cd worker && npx vitest run src/cron/__tests__/weekly-recap.test.ts -t "normalizes weekly meta"
```
Expected: PASS if the post-2026-04-15 normalization is wired correctly; FAIL otherwise.

- [ ] **Step 3: If the test failed, fix the wiring**

The most likely fix: verify that `metaFactory` in `weekly-recap.ts` spreads `parsedMeta` (which is already post-normalization) and does not replace the normalized values. If some branch sets `lead` or `tone` from non-parsedMeta sources, remove it.

- [ ] **Step 4: Re-run the test** — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/__tests__/weekly-recap.test.ts
# + worker/src/cron/weekly-recap.ts if a fix was needed
git commit -m "test(digest): lock in weekly meta normalization invariant"
```

---

## Task 17: Documentation updates (includes repo-wide `opus-4-6` grep)

**Files:**
- Modify: `docs/digest-pipeline.md:73, :252` — bump model; add sections on adaptive thinking + max effort, voice guards, Momentum Candidates, WoW deltas, chain flow, total mcap ATH, expanded enums, leadFamily variety check.
- Modify: `docs/worker-and-api-limits.md:122, :130` — bump timeout and model; add thinking/effort line.
- Optional: `README.md`, `CLAUDE.md` — if either contains a model string, update; otherwise leave.
- Verify: no stale `opus-4-6` outside `agents/plans/historical/` (historical files should NOT be rewritten).

- [ ] **Step 1: Run the grep gate first** to identify every non-historical occurrence.

```bash
rg -n "opus-4-6" --glob '!agents/plans/historical/**' --glob '!node_modules/**' --glob '!.next/**' --glob '!worktrees/**' .
```

Expected (after all prior tasks): only this plan file, `docs/digest-pipeline.md`, `docs/worker-and-api-limits.md`, and `worker/src/cron/digest/platform.ts` should match. The worker file matches come from the git-diff-friendly comment the rewrite commit leaves, if any — otherwise it will be zero after Task 2. Document the current state.

- [ ] **Step 2: Edit `docs/digest-pipeline.md`**

- Line 73: change `claude-opus-4-6` to `claude-opus-4-7`. Append: `with adaptive thinking (thinking.type = "adaptive") and max reasoning effort (output_config.effort = "max")`.
- Under **LLM call**, add a bullet: `Adaptive thinking is on by default with omitted display; no budget_tokens is needed. Sampling parameters (temperature / top_p / top_k) are not sent.`
- Under **Quality gate**, replace the existing text with: `Parsed LLM output is validated by hard rules (required fields, paragraph/word budget, title+text length, code fence) and soft voice guards (forbidden tics, opening-pattern repetition, missing forward-look, repeated lead-family, tone-cluster). A single corrective retry runs if any issue fires. If hard issues remain after retry, the digest is stored as degraded but social posting is skipped.`
- In the data-collection table, add two rows: `| Chain-level flow | mintBurnFlows.topChains | Top 3 chains by absolute 24h net flow |` and `| Total mcap ATH | derived from daily_digest archive | Anchors total market cap vs its Digest-window ATH |`.
- In the weekly data-collection table, add: `| Week-over-week deltas | prior 7 daily rows | current / prior values for mcap, PSI midpoint, PSI dominant band, active-depeg observations, unique depeg signals, blacklist events/USD, grade transitions, gauge midpoint |`.
- Line 252: change `claude-opus-4-6` to `claude-opus-4-7`.

- [ ] **Step 3: Edit `docs/worker-and-api-limits.md`**

- Line 122: update to `| Daily digest LLM call | \`300_000 ms\` | \`worker/src/lib/constants.ts\` |`.
- Line 130: change `claude-opus-4-6` to `claude-opus-4-7`.
- Add after the `timeout` line: `- thinking: adaptive; output_config.effort: max`.

- [ ] **Step 4: Optional checks**

```bash
rg -n "opus-4-6" README.md CLAUDE.md 2>/dev/null
rg -n "claude-opus-4-6" --glob '!agents/plans/historical/**' --glob '!node_modules/**' --glob '!.next/**' --glob '!worktrees/**' .
```

Fix any stale occurrence.

- [ ] **Step 5: Run the doc-count guard**

```
npm run check:doc-counts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/digest-pipeline.md docs/worker-and-api-limits.md
git commit -m "docs(digest): document Opus 4.7, voice guards, chain flow, WoW deltas, new enums"
```

---

## Task 18: Local verification + live-fixture replay + voice review gate

**Files:** none modified. Verification only.

- [ ] **Step 1: Full worker test run**

```
cd worker && npx vitest run
```
Expected: all green.

- [ ] **Step 2: Worker type check**

```
cd worker && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Root-package test run**

```
npm test -- --run
```
Expected: green.

- [ ] **Step 4: Lint**

```
npm run lint
```
Expected: green (or only pre-existing warnings).

- [ ] **Step 5: Pre-push merge gate**

```
npm run test:merge-gate
```
Expected: green.

- [ ] **Step 6: Live-fixture replay (manual voice review)**

Voice quality cannot be unit-tested. Before merging:

- [ ] Create a script at `agents/scripts/replay-digest-prompt.ts` (this location is valid under the `agents/` convention and may be committed). It should:
  - Pull the most recent 3 non-weekly `input_data` rows from production D1 via `wrangler d1 execute stablecoin-db --remote ...`.
  - For each row, call `buildUserPrompt(data, [])` and post to `POST https://api.anthropic.com/v1/messages` with the same body shape used by `platform.ts` (`claude-opus-4-7`, `thinking: {type: "adaptive"}`, `output_config: {effort: "max"}`, `max_tokens: 16000`, `system: SYSTEM_PROMPT`).
  - Print each response JSON to stdout.
- [ ] Run it against real `ANTHROPIC_API_KEY`. Compare each replayed digest against the old production digest from the same `input_data`:
  - Is the opening less PSI-templated?
  - Does each include a forward-look line?
  - Are tics absent?
  - Is the "one sharp sentence" doing work?
  - Is the tone varied across the 3 replays (≥2 distinct tones)?
- [ ] If ≥2 of the 3 replays fail the voice review, iterate on Tasks 13 / 14 prompt text before merging.
- [ ] After the voice review passes, commit the script (it is a useful ops tool).

- [ ] **Step 7: Final branch-cap commit**

```bash
git add agents/scripts/replay-digest-prompt.ts
git commit -m "chore(digest): add replay-digest-prompt ops script"
```

---

## Plan Review Loop

### Review 1 findings (summary)

A general-purpose reviewer flagged:
- Task 2 — Opus 4.7 contract: reviewer claimed `thinking.type: "adaptive"` and `output_config.effort: "max"` were wrong. **False positive** — both are explicitly documented in the `claude-api` skill (cached 2026-04-15). Added a Models-API capability check to Task 2 as defense anyway.
- Task 13 (old numbering, now Task 12) — weekly cutoff window not bounded. **Fixed** with `LIMIT 15` and timestamp-based split.
- Task 14 (old, now Task 15) — confirmed frontend dependency on `medianGrade/aboveBCount/fCount`. **Plan preserves the collector** and only drops the prompt line; added an explicit callout.
- Task 11 (old, now Task 9) — `chainId` vs `chainName` inconsistency. **Fixed** to `chainId` only.
- Task 12 (old, now Task 10) — `MAX()` + `ORDER BY` SQL was ambiguous. **Fixed** to plain `ORDER BY ... DESC LIMIT 1`.
- Task 13 (old, now Task 12) — field-name drift `currentMid` vs `currentEnd`. **Harmonized** to `{current, prior, delta/deltaPct}`.
- Task 6 — `worth watching` too aggressive. **Scoped to closer position** only.
- Ordering inversion — prompt rewrites referenced data added in later tasks. **Re-ordered**: data tasks (9-12) now precede prompt rewrites (13-14).
- Missed: novelty-driven forward-watch block. **Added Task 11** (Momentum Candidates).
- Missed: few-shot exemplar in the system prompt. **Added to Task 13** as an EXEMPLAR block.
- Task 4 — unchecked enum growth breaks variety. **Added `leadFamily` mapper** + `repeated-lead-family` validator.
- Task 1 — missed weekly timeout assertion. **Added** in Task 1.
- Task 15 (old) — mislabeled TDD. **Re-labeled** as verification in Task 16.
- Task 3 — missing cost disclaimer. **Added.**
- Task 16 — missing repo-wide grep. **Added** in Task 17 Step 1.
- Task 17 — ad-hoc script policy conflict. **Clarified**: place in `agents/scripts/` and commit.

### Review 1 corrections applied

Every finding marked **valid** has a fix inline. Plan grew from 17 tasks to 18 (Momentum Candidates).

### Review 2 findings (summary)

Second independent reviewer pass. Final count: Critical 0, High 1, Minor 2.

- **High, Task 6** — The closer-scoped `worth watching` regex was anchored with `$` (end of string). Because `findForbiddenTics` already scopes the haystack to the last sentence, the extra `$` anchor missed phrases followed by a tail like `"into next week."`. The Step 4 test would fail after Step 3 implementation.
- **Minor, Task 12** — `weekBoundary = now - 7 * ONE_DAY` drifts at the second level across weekly runs; the prior-Monday daily could land in the current or prior bucket depending on when it was generated vs the current run start.
- **Minor, Task 13** — Exemplar contained two notably colorful phrases ("confidence and caution sharing a desk", "loudest chair in the room"). Models tend to copy concrete phrasing from exemplars; embedding these risks creating the next generation of tics.

### Review 2 corrections applied (Revision 3)

- Task 6 — removed the `$` anchor from `FORBIDDEN_TICS_CLOSER` so a closer-position tic fires regardless of whether it is followed by a short tail. Added an inline comment explaining why.
- Task 12 — snapped `weekBoundary` to the UTC day boundary `todayTs - 6 * SECONDS.ONE_DAY` (= last Tuesday 00:00 UTC given the Monday 08:05 cron slot). Day-level snap removes sub-second ambiguity between weekly runs.
- Task 13 — rewrote the EXEMPLAR: removed the two risky phrases, kept structural elements (open from candidate fact, numbers throughout, one asymmetry, forward-look closer) and reduced metaphor density. Added an explicit "metaphors are intentionally spare" caveat to the exemplar header.

### Review 3 findings

Final count: **Critical 0, High 0, Minor 0.** All three Revision 3 fixes verified correct. Regex anchor removal passes all three Task 6 test cases under the `findForbiddenTics` last-sentence scoping; UTC-day-aligned `weekBoundary` is edge-safe for the Monday 08:05 cron; exemplar scrubbed of imitable phrases with an explicit "intentionally spare" caveat; soft/hard validator severity distribution unchanged.

### Final review

**READY TO EXECUTE.** The plan meets the stopping criterion (fewer than 2 minor issues). Proceed to task-by-task implementation via `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

---

## Verification Gaps

- **Voice quality is not fully unit-testable.** Task 18's replay step is the human gate.
- **Opus 4.7 pricing.** At $5 input / $25 output per Mtok. Daily: single-digit-dollar typical, up to ~$1.20 at the 16k cap. Weekly: up to ~$1.50. Annualized worst-case ≈$550.
- **Thinking tokens are not cache-friendly.** Once-daily cron — no change.
- **Compaction / streaming.** Not used. If max-effort thinking ever misses the 300s client timeout, escalate by enabling streaming in `platform.ts`. Deferred; observe first post-deploy week.
- **Momentum Candidate filter is narrow.** Only `new`/`accelerating`/`reversal` qualify. If observed novelty distribution skews to `worsening`/`improving`, broaden the filter.

---

## Post-Deploy Observability Checklist

After the branch merges and the first digest runs under the new configuration:

- Check the cron log for `[daily-digest] Calling Claude API`. Verify no 529/timeout.
- Record and review `usage.output_tokens` on the first 5 runs. If consistently >10k, consider dropping `max_tokens` toward 12k; if the cap is ever hit (truncation), raise further.
- Inspect `daily_digest.input_data` for new fields: `mintBurnFlows.topChains`, `totalMcapAth`; weekly `weekOverWeekDeltas`.
- Inspect `daily_digest.digest_meta.lead` / `.tone` across 5 consecutive digests; confirm ≥3 distinct lead families and ≥3 distinct tones.
- Read the first week of outputs. Confirm at least one forward-look line per digest. Confirm no "plumbing", no closer-position "worth watching".
- If any check fails, file a follow-up ticket and do not revert — the quality gate + retry self-correct; tics or enum gaps exposed in production feed into expansion tasks (extend `FORBIDDEN_TICS_ANYWHERE`, add to `ALLOWED_LEADS`, etc.).
