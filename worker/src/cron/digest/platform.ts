import type { DigestModelResponseParseOptions } from "../daily-digest/response";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE } from "../../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { parseDigestModelResponse } from "../daily-digest/response";

interface RequestDigestCopyOptions {
  db: D1Database;
  anthropicApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
  logPrefix: string;
  parseOptions?: DigestModelResponseParseOptions;
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
    };
  }

  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: options.maxTokens,
        system: options.systemPrompt,
        messages: [{ role: "user", content: options.userPrompt }],
      }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)])
        : AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    },
    ANTHROPIC_MAX_RETRIES,
    { timeoutMs: ANTHROPIC_TIMEOUT_MS },
  );

  if (!response || !response.ok) {
    await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, false);
    const errorText = response ? await response.text() : "no response after retries";
    throw new Error(
      `Claude API error ${response?.status ?? "null"}: ${typeof errorText === "string" ? errorText.slice(0, 500) : errorText}`,
    );
  }
  await recordOutcomeSafe(options.db, CIRCUIT_SOURCE.ANTHROPIC, true);

  const result = (await response.json()) as {
    content?: { type: string; text: string }[];
  };
  const rawText = result.content?.[0]?.text ?? "";
  if (!rawText) {
    throw new Error("Claude API returned empty digest text");
  }

  const parsed = parseDigestModelResponse(rawText, options.parseOptions);
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

  return {
    kind: "ok",
    ...parsed,
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
