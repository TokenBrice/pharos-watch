import type {
  DigestModelResponseParseOptions,
  DigestValidationIssue,
  DigestValidationProfile,
} from "../daily-digest/response";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE } from "../../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  formatDigestValidationIssues,
  hasBlockingDigestQualityIssues,
  parseDigestModelResponse,
  validateDigestModelOutput,
} from "../daily-digest/response";
import { accumulateAnthropicStream } from "./anthropic-stream";

interface RequestDigestCopyOptions {
  db: D1Database;
  anthropicApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
  logPrefix: string;
  parseOptions?: DigestModelResponseParseOptions;
  validationProfile?: DigestValidationProfile;
}

interface RequestDigestCopyResult {
  kind: "ok" | "circuit-open";
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  digestMeta: string | null;
  strippedDashCount: number;
  strippedForbiddenCharCount: number;
  usedRawTextFallback: boolean;
  qualityIssues: DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
}

interface InsertDigestRecordOptions {
  db: D1Database;
  generatedAt: number;
  digestText: string;
  digestTitle: string | null;
  inputData: unknown;
  digestExtended: string | null;
  digestMeta: string | null;
}

interface RunDigestChannelDeliveryOptions<TCreds> {
  db: D1Database;
  circuitSource: string;
  creds: TCreds | null;
  logPrefix: string;
  channelLabel: string;
  deliver: (creds: TCreds) => Promise<string | void>;
}

/** Fraction of ANTHROPIC_TIMEOUT_MS after which the corrective retry is skipped. */
const CORRECTIVE_RETRY_BUDGET_FRACTION = 0.5;

/**
 * Per-attempt fetch timeout for the digest call, shorter than ANTHROPIC_TIMEOUT_MS
 * so a single stalled attempt cannot consume the whole outer budget.
 */
const DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS = 11 * 60_000;

/**
 * Retry depth for the digest Anthropic call. Kept small because the outer
 * AbortSignal caps total wall time at ANTHROPIC_TIMEOUT_MS anyway, and extra
 * retries only stack 529 backoff delays inside that budget.
 */
const DIGEST_FETCH_MAX_RETRIES = 2;

export async function requestDigestCopy(
  options: RequestDigestCopyOptions,
): Promise<RequestDigestCopyResult> {
  if (!(await shouldAttemptFetch(options.db, CIRCUIT_SOURCE.ANTHROPIC))) {
    return {
      kind: "circuit-open",
      digestTitle: "",
      digestText: "",
      digestExtended: "",
      digestMeta: "",
      strippedDashCount: 0,
      strippedForbiddenCharCount: 0,
      usedRawTextFallback: false,
      qualityIssues: [],
      hasBlockingQualityIssues: false,
    };
  }

  const started = Date.now();

  const requestClaude = async (userPrompt: string): Promise<string> => {
    const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: options.maxTokens,
        thinking: { type: "adaptive" },
        // `max` has no constraint on thinking depth and caused runaway adaptive
        // thinking to consume the entire max_tokens budget (16k, then 32k)
        // before any text block started. `xhigh` is Opus 4.7's recommended level
        // for complex editorial work and the default in Claude Code.
        output_config: { effort: "xhigh" },
        system: options.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        // Streaming is required on Cloudflare Workers: Opus 4.7 with adaptive
        // thinking can think for minutes before emitting the first byte of a
        // non-streaming response, and CF severs the subrequest after ~130s of
        // inactivity. Streaming flushes headers + ping events immediately,
        // keeping the subrequest alive.
        stream: true,
      }),
      // Outer AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS) is the binding cap for
      // total wall time across any retries; the inner fetch-retry timeoutMs is
      // a per-attempt safety net.
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
        : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    },
    DIGEST_FETCH_MAX_RETRIES,
    { timeoutMs: DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS },
    );

    if (!response || !response.ok) {
      await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, false);
      const errorText = response ? await response.text() : "no response after retries";
      throw new Error(
        `Claude API error ${response?.status ?? "null"}: ${typeof errorText === "string" ? errorText.slice(0, 500) : errorText}`,
      );
    }

    // Record circuit-breaker outcome AFTER the stream resolves (success or
    // failure), so a stream that errors mid-flight is counted as a failure.
    let rawText: string;
    try {
      rawText = await accumulateAnthropicStream(response);
    } catch (streamErr) {
      await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, false);
      throw streamErr;
    }
    await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, true);
    return rawText;
  };

  let prompt = options.userPrompt;
  let parsed = parseDigestModelResponse(await requestClaude(prompt), options.parseOptions);
  let qualityIssues = options.validationProfile
    ? validateDigestModelOutput(parsed, options.validationProfile)
    : [];

  if (qualityIssues.length > 0) {
    const elapsedMs = Date.now() - started;
    const budgetMs = ANTHROPIC_TIMEOUT_MS * CORRECTIVE_RETRY_BUDGET_FRACTION;
    if (elapsedMs >= budgetMs) {
      console.warn(
        `[${options.logPrefix}] Digest quality checks failed but skipping corrective retry: elapsed ${elapsedMs}ms >= ${budgetMs}ms (${CORRECTIVE_RETRY_BUDGET_FRACTION * 100}% of budget). Issues: ${formatDigestValidationIssues(qualityIssues)}`,
      );
    } else {
      console.warn(
        `[${options.logPrefix}] Digest quality checks failed, retrying once (elapsed ${elapsedMs}ms): ${formatDigestValidationIssues(qualityIssues)}`,
      );
      prompt = [
        options.userPrompt,
        "",
        "REVISION REQUIRED:",
        "Your previous response failed these quality checks:",
        formatDigestValidationIssues(qualityIssues),
        "Return ONLY corrected JSON with the same schema. Do not add markdown fences or commentary.",
      ].join("\n");
      parsed = parseDigestModelResponse(await requestClaude(prompt), options.parseOptions);
      qualityIssues = options.validationProfile
        ? validateDigestModelOutput(parsed, options.validationProfile)
        : [];
    }
  }

  if (parsed.usedRawTextFallback) {
    console.warn(`[${options.logPrefix}] Failed to parse JSON response, using raw text fallback`);
  }
  if (parsed.strippedDashCount > 0) {
    console.log(`[${options.logPrefix}] Prompt compliance: ${parsed.strippedDashCount} forbidden dashes stripped`);
  }
  if (parsed.strippedForbiddenCharCount > 0) {
    console.warn(
      `[${options.logPrefix}] Prompt compliance: stripped ${parsed.strippedForbiddenCharCount} chars of forbidden phrases`,
    );
  }
  if (qualityIssues.length > 0) {
    console.warn(`[${options.logPrefix}] Digest quality checks still failing: ${formatDigestValidationIssues(qualityIssues)}`);
  }

  return {
    kind: "ok",
    ...parsed,
    qualityIssues,
    hasBlockingQualityIssues: hasBlockingDigestQualityIssues(qualityIssues),
  };
}

export async function insertDigestRecord(options: InsertDigestRecordOptions): Promise<void> {
  await options.db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      options.generatedAt,
      options.digestText,
      options.digestTitle,
      JSON.stringify(options.inputData),
      options.digestExtended,
      options.digestMeta,
    )
    .run();
}

export async function runDigestChannelDelivery<TCreds>(
  options: RunDigestChannelDeliveryOptions<TCreds>,
): Promise<string> {
  if (!options.creds) {
    return "no-creds";
  }
  const allowed = await shouldAttemptFetch(options.db, options.circuitSource);
  if (!allowed) {
    return "skipped: circuit-open";
  }

  try {
    const result = await options.deliver(options.creds);
    await recordOutcomeSafe(options.db, options.circuitSource, true);
    return result ?? "ok";
  } catch (err) {
    await recordOutcomeSafe(options.db, options.circuitSource, false);
    console.error(`[${options.logPrefix}] Failed to post to ${options.channelLabel} (non-fatal):`, err);
    return `failed: ${String(err).slice(0, 100)}`;
  }
}
