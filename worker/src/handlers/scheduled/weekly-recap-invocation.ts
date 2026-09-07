import { generateWeeklyRecap } from "../../cron/weekly-recap";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import {
  buildTelegramCreds,
  buildTwitterCreds,
  missingTelegramCredentialNames,
  missingTwitterCredentialNames,
} from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { WEEKLY_RECAP_LLM_CONFIG } from "../../lib/constants";
import { resolveDigestLlmConfig } from "../../cron/digest/platform";
import { resolveTelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";

/**
 * Single binding of the weekly recap to a scheduled runtime.
 *
 * Two slots reach the same job: the Monday 08:10 trigger and the five-minute
 * poll's Monday resume path, which regenerates a weekly edition the 08:10 slot
 * never produced. Both must resolve credentials, missing-credential
 * diagnostics, and the edition date identically, so the wiring lives here once
 * rather than being copied into each caller.
 *
 * The edition date comes from `slotStartedAt`, not the wall clock: a Monday
 * event delivered after 00:00 Tuesday still belongs to Monday's edition.
 */
export function runWeeklyRecapForRuntime(
  runtime: ScheduledRuntimeContext,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const llmConfig = resolveDigestLlmConfig(WEEKLY_RECAP_LLM_CONFIG, {
    model: "WEEKLY_DIGEST_MODEL" in runtime.env
      ? runtime.env.WEEKLY_DIGEST_MODEL
      : undefined,
    effort: "WEEKLY_DIGEST_EFFORT" in runtime.env
      ? runtime.env.WEEKLY_DIGEST_EFFORT
      : undefined,
    maxTokens: "WEEKLY_DIGEST_MAX_TOKENS" in runtime.env
      ? runtime.env.WEEKLY_DIGEST_MAX_TOKENS
      : undefined,
  });
  return generateWeeklyRecap(
    runtime.db,
    runtime.env.ANTHROPIC_API_KEY ?? null,
    buildTwitterCreds(runtime.env),
    buildTelegramCreds(runtime.env),
    signal,
    reportProgress,
    runtime.slotStartedAt,
    {
      twitterMissing: missingTwitterCredentialNames(runtime.env),
      telegramMissing: missingTelegramCredentialNames(runtime.env),
    },
    llmConfig,
    resolveTelegramRecapRolloutPolicy(runtime.env),
  );
}
