import { logWorkerEventArgs } from "../../lib/structured-log";
import type {
  DigestModelResponseParseOptions,
  DigestValidationIssue,
  DigestValidationProfile,
} from "../daily-digest/response";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { readResponseTextBoundedWithSignal } from "../../lib/response-body";
import {
  ANTHROPIC_TIMEOUT_MS,
  CIRCUIT_SOURCE,
  type DigestEffort,
  type DigestLlmConfig,
} from "../../lib/constants";
import { recordCronFailure } from "../../lib/cron-logger";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  formatDigestValidationIssues,
  hasBlockingDigestQualityIssues,
  parseDigestModelResponse,
  validateDigestModelOutput,
} from "../daily-digest/response";
import {
  accumulateAnthropicStream,
  AnthropicStreamFailure,
  type AnthropicRefusalCategory,
  type AnthropicStreamResult,
} from "./anthropic-stream";
import { tryParseJson } from "../../lib/json-parse";

interface RequestDigestCopyOptions {
  db: D1Database;
  anthropicApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  llmConfig: DigestLlmConfig;
  signal?: AbortSignal;
  logPrefix: string;
  parseOptions?: DigestModelResponseParseOptions;
  validationProfile?: DigestValidationProfile;
  reportAttempt?: (attempts: DigestLlmAttemptTelemetry[]) => Promise<void>;
}

export interface DigestLlmAttemptTelemetry {
  attemptNumber: number;
  requestKind: "original" | "corrective";
  httpAttempt: number;
  requestedModel: string;
  servedModel: string | null;
  effort: DigestEffort;
  maxTokens: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  refusalCategory: AnthropicRefusalCategory | null;
  latencyMs: number;
  costUsd: number | null;
  httpStatus: number | null;
}

interface RequestDigestCopyResult {
  kind: "ok" | "circuit-open" | "refusal";
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  digestMeta: string | null;
  strippedDashCount: number;
  forbiddenPhraseHits: string[];
  usedRawTextFallback: boolean;
  qualityIssues: DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
  llmAttempts: DigestLlmAttemptTelemetry[];
  refusalCategory: AnthropicRefusalCategory | null;
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

export type DigestChannelDisposition =
  | "delivered"
  | "retryable"
  | "terminal-unsent"
  | "not-configured";

/**
 * Map the status grammar shared by digest channel delivery paths to the
 * disposition used by cron publication decisions. Unknown statuses fail
 * closed: a status we do not understand must never look delivered.
 */
export function classifyDigestChannelStatus(status: string): DigestChannelDisposition {
  if (status === "ok" || status.startsWith("ok+")) return "delivered";
  if (status === "skipped: already-sent") return "delivered";

  if (
    status.startsWith("failed:")
    || status === "skipped: circuit-open"
    || status === "skipped: in-flight"
    || status === "skipped: stale-safety-identity"
    || status === "skipped: safety-identity-unavailable"
    || status === "queued: pending"
    || status === "queued: sending"
    || status === "queued: transport-control-unavailable"
    || status === "queued: transport-operator_pause"
    || status === "queued: transport-outage_open"
    || status === "queued: transport-probe_owned_elsewhere"
    || status === "outbox-pending"
    || status === "outbox-sending"
  ) {
    return "retryable";
  }

  if (
    status === "skipped: execution-unknown"
    || status === "skipped: attempt-limit"
    || status === "skipped: quality-gate"
    || status === "queued: execution_unknown"
    || status === "queued: failed_permanent"
    || status === "outbox-execution_unknown"
    || status === "outbox-failed_permanent"
  ) {
    return "terminal-unsent";
  }

  if (status === "skipped: no-creds") return "not-configured";
  if (status === "outbox-sent") return "delivered";
  // Telegram's transport helper predates the shared `skipped:` grammar and
  // still emits this legacy value when credentials are absent.
  if (status === "no-creds") return "not-configured";

  return "terminal-unsent";
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
const DIGEST_MAX_CONFIGURED_TOKENS = 16_000;
const SUPPORTED_DIGEST_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const;

interface DigestLlmConfigOverrides {
  model?: unknown;
  effort?: unknown;
  maxTokens?: unknown;
}

export function resolveDigestLlmConfig(
  fallback: DigestLlmConfig,
  overrides: DigestLlmConfigOverrides = {},
): DigestLlmConfig {
  const requestedModel = typeof overrides.model === "string" ? overrides.model.trim() : "";
  const model = SUPPORTED_DIGEST_MODELS.some((supportedModel) => supportedModel === requestedModel)
    ? requestedModel
    : fallback.model;
  const requestedEffort = typeof overrides.effort === "string" ? overrides.effort.trim() : "";
  const effort = requestedEffort === "low"
    || requestedEffort === "medium"
    || requestedEffort === "high"
    || requestedEffort === "xhigh"
    || requestedEffort === "max"
    ? requestedEffort
    : fallback.effort;
  const parsedMaxTokens = typeof overrides.maxTokens === "string"
    ? Number(overrides.maxTokens.trim())
    : overrides.maxTokens;
  const maxTokens = typeof parsedMaxTokens === "number"
    && Number.isSafeInteger(parsedMaxTokens)
    && parsedMaxTokens >= 1_000
    && parsedMaxTokens <= DIGEST_MAX_CONFIGURED_TOKENS
    ? parsedMaxTokens
    : fallback.maxTokens;
  return { model, effort, maxTokens };
}

interface ModelTokenPrices {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

function getModelTokenPrices(model: string): ModelTokenPrices | null {
  if (model.startsWith("claude-opus-5") || model.startsWith("claude-opus-4-8")) {
    return { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };
  }
  if (model.startsWith("claude-sonnet-5")) {
    return { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
  }
  if (model.startsWith("claude-fable-5")) {
    return { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 };
  }
  return null;
}

function computeAttemptCostUsd(result: AnthropicStreamResult): number | null {
  if (result.inputTokens == null || result.outputTokens == null) return null;
  const prices = result.servedModel ? getModelTokenPrices(result.servedModel) : null;
  if (!prices) return null;
  const cost = result.inputTokens * prices.input
    + (result.cacheWriteTokens ?? 0) * prices.cacheWrite
    + (result.cacheReadTokens ?? 0) * prices.cacheRead
    + result.outputTokens * prices.output;
  return Number((cost / 1_000_000).toFixed(6));
}

function isRetryableDigestStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function digestRetryDelayMs(response: Response | null, httpAttempt: number): number {
  const retryAfter = response?.headers.get("Retry-After")?.trim() ?? "";
  if (/^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, 120_000);
  }
  const baseMs = response?.status === 529 ? 5_000 : 1_000;
  const ceilingMs = response?.status === 529 ? 30_000 : 8_000;
  return Math.min(ceilingMs, Math.round(baseMs * 2 ** (httpAttempt - 1) * (0.5 + Math.random() * 0.5)));
}

function attachDigestLlmMeta(
  digestMeta: string | null,
  config: DigestLlmConfig,
  attempts: DigestLlmAttemptTelemetry[],
): string {
  let parsed: Record<string, unknown> = {};
  if (digestMeta) {
    const decoded = tryParseJson(digestMeta, { onFailure: () => undefined });
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      parsed = decoded as Record<string, unknown>;
    }
  }
  parsed.llm = {
    model: config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    attempts,
  };
  return JSON.stringify(parsed);
}

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
      llmAttempts: [],
      refusalCategory: null,
    };
  }

  const started = Date.now();
  const llmAttempts: DigestLlmAttemptTelemetry[] = [];
  let nextAttemptNumber = 1;

  const recordAttempt = async (
    requestKind: "original" | "corrective",
    httpAttempt: number,
    attemptStarted: number,
    response: Response | null,
    streamResult?: AnthropicStreamResult,
  ): Promise<void> => {
    llmAttempts.push({
      attemptNumber: nextAttemptNumber++,
      requestKind,
      httpAttempt,
      requestedModel: options.llmConfig.model,
      servedModel: streamResult?.servedModel ?? null,
      effort: options.llmConfig.effort,
      maxTokens: options.llmConfig.maxTokens,
      inputTokens: streamResult?.inputTokens ?? null,
      cacheReadTokens: streamResult?.cacheReadTokens ?? null,
      cacheWriteTokens: streamResult?.cacheWriteTokens ?? null,
      outputTokens: streamResult?.outputTokens ?? null,
      stopReason: streamResult?.stopReason ?? null,
      refusalCategory: streamResult?.refusalCategory ?? null,
      latencyMs: Date.now() - attemptStarted,
      costUsd: streamResult ? computeAttemptCostUsd(streamResult) : null,
      httpStatus: response?.status ?? null,
    });
    await options.reportAttempt?.(llmAttempts.map((attempt) => ({ ...attempt })));
  };

  const requestClaude = async (
    userPrompt: string,
    requestKind: "original" | "corrective",
  ): Promise<{ kind: "ok"; rawText: string } | { kind: "refusal"; category: AnthropicRefusalCategory | null }> => {
    const outerSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
      : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS);
    let lastErrorText = "no response after retries";

    for (let httpAttempt = 1; httpAttempt <= DIGEST_FETCH_MAX_RETRIES + 1; httpAttempt++) {
      const attemptStarted = Date.now();
      const response = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": options.anthropicApiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "server-side-fallback-2026-07-01",
            "Accept": "text/event-stream",
          },
          body: JSON.stringify({
            model: options.llmConfig.model,
            fallbacks: "default",
            max_tokens: options.llmConfig.maxTokens,
            thinking: { type: "adaptive" },
            // Retain xhigh: measured Opus 5 high runs omitted the mandated
            // forward-look line in both sampled dailies. The 16k ceiling,
            // rather than lower effort, provides the hard cost bound.
            output_config: { effort: options.llmConfig.effort },
            system: options.systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            // Streaming is required on Cloudflare Workers: adaptive thinking
            // can run for minutes before non-streaming response bytes arrive.
            stream: true,
          }),
          signal: outerSignal,
        },
        0,
        { timeoutMs: DIGEST_FETCH_PER_ATTEMPT_TIMEOUT_MS, returnFinalResponse: true },
      );

      if (!response || !response.ok) {
        lastErrorText = response
          ? await readDigestErrorText(response, outerSignal)
          : "no response";
        await recordAttempt(requestKind, httpAttempt, attemptStarted, response);
        if (
          httpAttempt <= DIGEST_FETCH_MAX_RETRIES
          && (!response || isRetryableDigestStatus(response.status))
        ) {
          await sleepWithSignal(digestRetryDelayMs(response, httpAttempt), outerSignal);
          continue;
        }
        await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, false);
        throw new Error(
          `Claude API error ${response?.status ?? "null"}: ${lastErrorText.slice(0, 500)}`,
        );
      }

      let streamResult: AnthropicStreamResult;
      try {
        streamResult = await accumulateAnthropicStream(response);
      } catch (streamErr) {
        const failedResult = streamErr instanceof AnthropicStreamFailure
          ? streamErr.result
          : undefined;
        await recordAttempt(requestKind, httpAttempt, attemptStarted, response, failedResult);
        await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, false);
        throw streamErr;
      }
      await recordAttempt(requestKind, httpAttempt, attemptStarted, response, streamResult);
      if (streamResult.stopReason === "refusal") {
        // Policy refusals are successful API transactions, but neither heal
        // nor damage the infrastructure circuit. Server-side fallback already
        // had the full request window to route to a recommended model.
        return { kind: "refusal", category: streamResult.refusalCategory };
      }
      await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, true);
      return { kind: "ok", rawText: streamResult.text };
    }

    throw new Error(`Claude API error null: ${lastErrorText.slice(0, 500)}`);
  };

  let prompt = options.userPrompt;
  const original = await requestClaude(prompt, "original");
  if (original.kind === "refusal") {
    return {
      kind: "refusal",
      digestTitle: "",
      digestText: "",
      digestExtended: "",
      digestMeta: null,
      strippedDashCount: 0,
      forbiddenPhraseHits: [],
      usedRawTextFallback: false,
      qualityIssues: [],
      hasBlockingQualityIssues: false,
      llmAttempts,
      refusalCategory: original.category,
    };
  }
  let parsed = parseDigestModelResponse(original.rawText, options.parseOptions);
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
      logWorkerEventArgs("handler", "warn",
        `[${options.logPrefix}] Digest quality checks failed but skipping corrective retry: elapsed ${elapsedMs}ms >= ${budgetMs}ms (${CORRECTIVE_RETRY_BUDGET_FRACTION * 100}% of budget). Issues: ${formatDigestValidationIssues(hardIssues)}`,
      );
    } else {
      logWorkerEventArgs("handler", "warn",
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
      const corrective = await requestClaude(prompt, "corrective");
      if (corrective.kind === "refusal") {
        return {
          kind: "refusal",
          digestTitle: "",
          digestText: "",
          digestExtended: "",
          digestMeta: null,
          strippedDashCount: 0,
          forbiddenPhraseHits: [],
          usedRawTextFallback: false,
          qualityIssues: [],
          hasBlockingQualityIssues: false,
          llmAttempts,
          refusalCategory: corrective.category,
        };
      }
      parsed = parseDigestModelResponse(corrective.rawText, options.parseOptions);
      qualityIssues = options.validationProfile
        ? validateDigestModelOutput(parsed, options.validationProfile)
        : [];
    }
  }

  if (parsed.usedRawTextFallback) {
    logWorkerEventArgs("handler", "warn", `[${options.logPrefix}] Failed to parse JSON response, using raw text fallback`);
  }
  if (parsed.strippedDashCount > 0) {
    logWorkerEventArgs("handler", "info", `[${options.logPrefix}] Prompt compliance: ${parsed.strippedDashCount} forbidden dashes stripped`);
  }
  if (parsed.forbiddenPhraseHits.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[${options.logPrefix}] Prompt compliance: forbidden phrase(s) present: ${parsed.forbiddenPhraseHits.map((phrase) => phrase.trim()).join(", ")}`,
    );
  }
  if (qualityIssues.length > 0) {
    logWorkerEventArgs("handler", "warn", `[${options.logPrefix}] Digest quality checks still failing: ${formatDigestValidationIssues(qualityIssues)}`);
  }

  return {
    kind: "ok",
    ...parsed,
    digestMeta: attachDigestLlmMeta(parsed.digestMeta, options.llmConfig, llmAttempts),
    qualityIssues,
    hasBlockingQualityIssues: hasBlockingDigestQualityIssues(qualityIssues),
    llmAttempts,
    refusalCategory: null,
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
  return classifyDigestChannelStatus(status) === "delivered";
}

export async function runDigestChannelDelivery<TCreds>(
  options: RunDigestChannelDeliveryOptions<TCreds>,
): Promise<string> {
  if (!options.creds) {
    return "skipped: no-creds";
  }
  const allowed = await shouldAttemptFetch(options.db, options.circuitSource);
  if (!allowed) {
    return "skipped: circuit-open";
  }

  try {
    const result = await options.deliver(options.creds);
    const status = result ?? "ok";
    // A non-throwing skip (for example already-sent, in-flight, or a safety
    // identity hold) did not make a provider request succeed. Leave the
    // breaker untouched unless the channel explicitly reports delivery.
    if (status === "ok" || status.startsWith("ok+")) {
      await recordOutcomeSafe(options.db, options.circuitSource, true);
    }
    return status;
  } catch (err) {
    await recordOutcomeSafe(options.db, options.circuitSource, false);
    recordCronFailure(options.logPrefix, err, {
      metadata: { stage: "channel-delivery", channel: options.channelLabel, fatal: false },
    });
    return `failed: ${String(err).slice(0, 100)}`;
  }
}
