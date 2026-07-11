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
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroupDefinition } from "./slot-groups";

const SLOT_LABEL = "daily 08:05 slot";

function buildDaily0805SlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroupDefinition[] {
  return [
    {
      mode: "parallel-serial",
      label: "daily-0805-chains",
      chains: [
        {
          label: "sync-bluechip",
          tasks: [
            {
              job: "sync-bluechip",
              run: (signal) => syncBluechip(runtime.db, signal),
            },
          ],
        },
        {
          label: "daily-digest",
          tasks: [
            {
              job: "daily-digest",
              run: (signal, reportProgress) =>
                generateDailyDigest(
                  runtime.db,
                  runtime.env.ANTHROPIC_API_KEY ?? null,
                  buildTwitterCreds(runtime.env),
                  false,
                  buildTelegramCreds(runtime.env),
                  signal,
                  reportProgress,
                ),
            },
          ],
        },
      ],
    },
  ];
}

export async function runDaily0805Slot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, SLOT_LABEL, buildDaily0805SlotGroups(runtime));
}
