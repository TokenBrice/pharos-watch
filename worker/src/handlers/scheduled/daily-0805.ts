/**
 * Daily 08:05 UTC trigger (5 8 * * *):
 *   sync-bluechip (3)          ← parallel chain
 *   daily-digest (1)           ← independent parallel chain
 *
 * Weekly recap runs in the separate 08:10 UTC slot so both LLM jobs receive
 * their full scheduled-event runtime budget on Mondays.
 * Connection budget: 4/6 peak.
 */
import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import {
  buildTelegramCreds,
  buildTwitterCreds,
  missingTelegramCredentialNames,
  missingTwitterCredentialNames,
} from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

const SLOT_LABEL = "daily 08:05 slot";

function buildDaily0805SlotGroups(runtime: ScheduledRuntimeContext) {
  return bindScheduledSlotPlan("daily0805Utc", {
    mode: "parallel-serial",
    label: "daily-0805-chains",
    chainLabels: ["sync-bluechip", "daily-digest"],
    implementations: {
      "sync-bluechip": (signal) => syncBluechip(runtime.db, signal),
      "daily-digest": (signal, reportProgress) =>
        generateDailyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTwitterCreds(runtime.env),
          false,
          buildTelegramCreds(runtime.env),
          signal,
          reportProgress,
          {
            twitterMissing: missingTwitterCredentialNames(runtime.env),
            telegramMissing: missingTelegramCredentialNames(runtime.env),
          },
        ),
    },
  });
}

export async function runDaily0805Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, SLOT_LABEL, buildDaily0805SlotGroups(runtime));
}
