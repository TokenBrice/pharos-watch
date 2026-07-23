import type {
  DigestModelResponseParseOptions,
  DigestValidationIssue,
  DigestValidationProfile,
} from "../daily-digest/response";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../../lib/abort";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { readResponseTextBoundedWithSignal } from "../../lib/response-body";
import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE, DIGEST_MODEL } from "../../lib/constants";
import { recordCronFailure } from "../../lib/cron-logger";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  formatDigestValidationIssues,
  hasBlockingDigestQualityIssues,
  parseDigestModelResponse,
  validateDigestModelOutput,
} from "../daily-digest/response";
import { accumulateAnthropicStream } from "./anthropic-stream";
import { tryParseJson } from "../../lib/json-parse";

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
  forbiddenPhraseHits: string[];
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
  signal?: AbortSignal;
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
const DIGEST_ERROR_BODY_TIMEOUT_MS = 15_000;
const DIGEST_ERROR_BODY_MAX_BYTES = 2_000;

async function readDigestErrorText(response: Response, signal?: AbortSignal): Promise<string> {
  const timeout = createTimeoutSignal({
    timeoutMs: DIGEST_ERROR_BODY_TIMEOUT_MS,
    timeoutReason: new DOMException(`digest error body read timed out after ${DIGEST_ERROR_BODY_TIMEOUT_MS}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return await readResponseTextBoundedWithSignal(response, DIGEST_ERROR_BODY_MAX_BYTES, timeout.signal);
  } finally {
    timeout.dispose();
  }
}

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
      forbiddenPhraseHits: [],
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
        model: DIGEST_MODEL,
        max_tokens: options.maxTokens,
        thinking: { type: "adaptive" },
        // `max` has no constraint on thinking depth and caused runaway adaptive
        // thinking to consume the entire max_tokens budget (16k, then 32k)
        // before any text block started. `xhigh` is Opus's recommended level
        // for complex editorial work and the default in Claude Code.
        output_config: { effort: "xhigh" },
        system: options.systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        // Streaming is required on Cloudflare Workers: Opus with adaptive
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
      const errorText = response ? await readDigestErrorText(response, options.signal) : "no response after retries";
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

  // Retry only on HARD issues. Soft variety issues used to trigger a second
  // full Opus call every day of a forced-lead streak, instructing the model to
  // fix repetition the hard lead requirement made unfixable.
  const hardIssues = qualityIssues.filter((issue) => issue.severity === "hard");
  if (hardIssues.length > 0) {
    const elapsedMs = Date.now() - started;
    const budgetMs = ANTHROPIC_TIMEOUT_MS * CORRECTIVE_RETRY_BUDGET_FRACTION;
    if (elapsedMs >= budgetMs) {
      console.warn(
        `[${options.logPrefix}] Digest quality checks failed but skipping corrective retry: elapsed ${elapsedMs}ms >= ${budgetMs}ms (${CORRECTIVE_RETRY_BUDGET_FRACTION * 100}% of budget). Issues: ${formatDigestValidationIssues(hardIssues)}`,
      );
    } else {
      console.warn(
        `[${options.logPrefix}] Digest quality checks failed, retrying once (elapsed ${elapsedMs}ms): ${formatDigestValidationIssues(hardIssues)}`,
      );
      prompt = [
        options.userPrompt,
        "",
        "REVISION REQUIRED:",
        "Your previous response (below) failed these quality checks:",
        formatDigestValidationIssues(hardIssues),
        "",
        "PREVIOUS RESPONSE:",
        JSON.stringify({
          title: parsed.digestTitle,
          text: parsed.digestText,
          extended: parsed.digestExtended,
          meta: parsed.digestMeta
            ? tryParseJson(parsed.digestMeta, { onFailure: () => undefined })
            : null,
        }),
        "",
        "Fix ONLY what the quality checks flag; keep everything else. Return ONLY corrected JSON with the same schema. Do not add markdown fences or commentary.",
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
  if (parsed.forbiddenPhraseHits.length > 0) {
    console.warn(
      `[${options.logPrefix}] Prompt compliance: forbidden phrase(s) present: ${parsed.forbiddenPhraseHits.map((phrase) => phrase.trim()).join(", ")}`,
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

/**
 * Flag a digest_meta payload as blocked by the quality gate. Blocked rows are
 * stored for operator inspection but excluded from every public read surface
 * and from edition numbering (see NON_BLOCKED_DIGEST_SQL_FILTER).
 */
export function markDigestMetaBlocked(digestMeta: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (digestMeta) {
    const decoded = tryParseJson(digestMeta, { onFailure: () => undefined });
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      parsed = decoded as Record<string, unknown>;
    }
  }
  parsed.qualityGate = "blocked";
  return JSON.stringify(parsed);
}

export async function insertDigestRecord(options: InsertDigestRecordOptions): Promise<void> {
  throwIfAborted(options.signal);
  const inputDataJson = JSON.stringify(options.inputData);

  await runWithOverloadRetry(() =>
    options.db
      .prepare(
        `INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1
              FROM daily_digest
             WHERE generated_at = ?
               AND digest_text = ?
               AND digest_title IS ?
               AND input_data = ?
               AND digest_extended IS ?
               AND digest_meta IS ?
          )`,
      )
      .bind(
        options.generatedAt,
        options.digestText,
        options.digestTitle,
        inputDataJson,
        options.digestExtended,
        options.digestMeta,
        options.generatedAt,
        options.digestText,
        options.digestTitle,
        inputDataJson,
        options.digestExtended,
        options.digestMeta,
      )
      .run(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
}

export function didDigestChannelDeliver(status: string): boolean {
  return status === "ok" || status.startsWith("ok+");
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
    recordCronFailure(options.logPrefix, err, {
      metadata: { stage: "channel-delivery", channel: options.channelLabel, fatal: false },
    });
    return `failed: ${String(err).slice(0, 100)}`;
  }
}
