

/**
 * Anthropic digest generation request timeout.
 * Sized under the 15-min Cloudflare scheduled-event ceiling with ~3 min of
 * headroom for persistence, channel delivery, and cron_runs logging. The
 * digest call site overrides the per-attempt fetch timeout so a runaway
 * retry cannot consume the outer budget.
 */
export const ANTHROPIC_TIMEOUT_MS = 12 * 60_000;

export const DIGEST_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type DigestEffort = (typeof DIGEST_EFFORT_LEVELS)[number];

export interface DigestLlmConfig {
  model: string;
  effort: DigestEffort;
  maxTokens: number;
}

/**
 * Opus 5.5 runs streaming safety classifiers that can refuse a request. The
 * digest request path handles that policy outcome separately from provider
 * failures so it cannot poison the Anthropic circuit breaker.
 */
export const DIGEST_MODEL = "claude-opus-5-5";

/**
 * Per-request output ceiling (thinking + visible text) for both digest jobs,
 * and the upper bound for runtime `maxTokens` overrides. A `max_tokens` stop
 * loses the edition, so this sits about 2.5x above the largest Opus 5.5 `high`
 * generation measured on production prompts (6,455 tokens, weekly 2026-09-07).
 */
export const DIGEST_MAX_TOKENS = 16_000;

/**
 * Output tokens one edition may bill across every attempt: the original leg,
 * the corrective retry, and any HTTP retry of either. A request starts only
 * when its full `max_tokens` still fits. Two full requests means a corrective
 * retry always fits after a completed first pass, and one retry fits after a
 * request whose usage never came back (charged the full ceiling).
 *
 * `max_tokens` alone does not bound spend: up to `DIGEST_FETCH_MAX_RETRIES + 1`
 * generations per leg across two legs can bill. With six billed input charges
 * at the largest observed prompts, 32,000 output tokens puts one invocation per
 * edition at about $1.12/day (daily plus weekly/7) at Opus 5.5 prices, under
 * the $1.15 ceiling. Extra invocations (manual force-runs, Monday weekly
 * resumes) each carry their own budget, and a mid-output server-side fallback
 * can bill one extra partial generation inside a request before it is charged.
 */
export const DIGEST_MAX_EDITION_OUTPUT_TOKENS = 2 * DIGEST_MAX_TOKENS;

/**
 * Edition output budget under the `heavy` profile: the standard budget (draft
 * plus corrective) plus one full request each for the evidence audit and the
 * revision. The same full-ceiling reservation applies before every request, so
 * a heavy stage that no longer fits is skipped and the draft publishes.
 *
 * A 2026-10-12 replay of ten production dailies measured heavy at $0.42-0.65
 * per edition (median $0.53) in 151 s median. Worst case at this budget is
 * about twelve billed ~22k-token inputs plus 64k output tokens, roughly $2.30
 * per invocation at Opus 5.5 prices. This is a per-invocation token budget,
 * not a monetary cap.
 */
export const DIGEST_HEAVY_MAX_EDITION_OUTPUT_TOKENS = 4 * DIGEST_MAX_TOKENS;

/**
 * `high`, not `xhigh`: on the same production prompts Opus 5.5 at `xhigh`
 * emitted 11-12k output tokens per daily and 19,996 on the heaviest weekly
 * (up to 2.8x Opus 5 at `xhigh`), which no ceiling inside the cost envelope
 * can hold. At `high` it emitted 3.5-6.5k, and kept the forward-look line on
 * two of three sampled dailies where Opus 5 at `xhigh` kept it on none.
 */
export const DAILY_DIGEST_LLM_CONFIG: DigestLlmConfig = {
  model: DIGEST_MODEL,
  effort: "high",
  maxTokens: DIGEST_MAX_TOKENS,
};

export const WEEKLY_RECAP_LLM_CONFIG: DigestLlmConfig = {
  model: DIGEST_MODEL,
  effort: "high",
  maxTokens: DIGEST_MAX_TOKENS,
};
