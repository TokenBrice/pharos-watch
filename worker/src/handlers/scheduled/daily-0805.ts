/**
 * Daily 08:05 UTC trigger (5 8 * * *):
 *   sync-bluechip (3)          ← parallel waitUntil
 *   daily-digest (1) → weekly-digest (1)  ← chained to share connection pool
 *
 * Digests are chained; bluechip runs as an independent waitUntil promise.
 * Worst case peak is bluechip batch (3) + digest chain (1).
 * Connection budget: 4/6 peak.
 */
import { syncBluechip } from "../../cron/sync-bluechip";
import { generateDailyDigest } from "../../cron/daily-digest";
import { generateWeeklyRecap } from "../../cron/weekly-recap";
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
          label: "digest-chain",
          tasks: [
            {
              job: "daily-digest",
              run: (signal) =>
                generateDailyDigest(
                  runtime.db,
                  runtime.env.ANTHROPIC_API_KEY ?? null,
                  buildTwitterCreds(runtime.env),
                  false,
                  buildTelegramCreds(runtime.env),
                  signal,
                ),
            },
            {
              job: "weekly-recap",
              run: (signal) =>
                generateWeeklyRecap(
                  runtime.db,
                  runtime.env.ANTHROPIC_API_KEY ?? null,
                  buildTelegramCreds(runtime.env),
                  signal,
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
