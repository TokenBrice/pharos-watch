/**
 * Reviewed dependency registry for the Telegram load guard.
 *
 * The adaptive PR gate and weekly workflow consume this registry directly.
 */
export const TELEGRAM_LOAD_ADVISORY_COMMAND = "npm run check:telegram-load";

interface TelegramLoadGuardDependencyGroup {
  id: string;
  reason: string;
  paths: string[];
  examples: string[];
}

export const TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS: TelegramLoadGuardDependencyGroup[] = [
  {
    id: "guard-contract",
    reason: "load model, trigger registry, workflow, and their regression tests",
    paths: [
      ".github/workflows/weekly-validation.yml",
      "scripts/ci/check-telegram-load.ts",
      "scripts/lib/telegram-load-scenarios.ts",
      "scripts/lib/telegram-load-guard.mts",
      "scripts/__tests__/check-telegram-load.test.ts",
    ],
    examples: ["scripts/ci/check-telegram-load.ts"],
  },
  {
    id: "delivery-policy",
    reason: "runtime delivery limits, scheduled timeout, Worker compatibility exports, and CPU cap",
    paths: [
      "shared/lib/telegram-delivery-policy.ts",
      "worker/src/lib/telegram-constants.ts",
      "worker/src/lib/cron-timeouts.ts",
      "worker/wrangler.toml",
    ],
    examples: ["shared/lib/telegram-delivery-policy.ts", "worker/src/lib/cron-timeouts.ts"],
  },
  {
    id: "dispatch-and-pending",
    reason: "fan-out orchestration, routing, delivery, overflow, and durable pending work",
    paths: [
      "worker/src/cron/dispatch-telegram-*.ts",
      "worker/src/cron/telegram-pending/**",
    ],
    examples: [
      "worker/src/cron/dispatch-telegram-routing.ts",
      "worker/src/cron/telegram-pending/drain.ts",
    ],
  },
  {
    id: "job-target-schema",
    reason: "durable source-event, job, target, effect, and status contracts",
    paths: ["worker/src/cron/telegram-alert-*.ts", "worker/migrations/**"],
    examples: [
      "worker/migrations/0183_telegram_fresh_target_effect_fencing.sql",
    ],
  },
  {
    id: "sender",
    reason: "Bot API transport, response classification, batching, and global rate-limit detection",
    paths: ["worker/src/lib/telegram.ts"],
    examples: ["worker/src/lib/telegram.ts"],
  },
  {
    id: "preset-resolution",
    reason: "dynamic preset membership and persisted preset intent affect fan-out size",
    paths: [
      "shared/lib/telegram-presets.ts",
      "worker/src/lib/telegram-presets.ts",
      "worker/src/api/telegram-store/presets.ts",
    ],
    examples: ["worker/src/lib/telegram-presets.ts"],
  },
  {
    id: "formatter-and-chunker",
    reason: "message consolidation and splitting determine chunk count and send demand",
    paths: [
      "worker/src/api/telegram-format.ts",
      "worker/src/lib/telegram-alerts.ts",
      "worker/src/lib/telegram-alerts-formatting.ts",
    ],
    examples: ["worker/src/lib/telegram-alerts-formatting.ts"],
  },
  {
    id: "scheduled-lane",
    reason: "cadence, connection budget, runner chain, and five-minute lane ownership",
    paths: [
      "shared/lib/cron-jobs.ts",
      "shared/lib/scheduled-runner-registry.ts",
      "worker/src/handlers/scheduled/five-minute-telegram.ts",
    ],
    examples: ["worker/src/handlers/scheduled/five-minute-telegram.ts"],
  },
  {
    id: "admin-broadcast",
    reason: "broadcast fan-out shares the pending queue and delivery budget",
    paths: ["worker/src/api/admin-telegram-broadcast.ts"],
    examples: ["worker/src/api/admin-telegram-broadcast.ts"],
  },
];

export const TELEGRAM_LOAD_GUARD_PATHS: string[] = [
  ...new Set(TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS.flatMap((group) => group.paths)),
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function matchesTelegramLoadGuardPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  const memo = new Map<string, boolean>();

  function match(pathIndex: number, patternIndex: number): boolean {
    const memoKey = `${pathIndex}:${patternIndex}`;
    if (memo.has(memoKey)) return memo.get(memoKey) ?? false;

    let matched;
    if (patternIndex === normalizedPattern.length) {
      matched = pathIndex === normalizedPath.length;
    } else if (normalizedPattern[patternIndex] === "*") {
      const isDoubleStar = normalizedPattern[patternIndex + 1] === "*";
      const nextPatternIndex = patternIndex + (isDoubleStar ? 2 : 1);
      matched = match(pathIndex, nextPatternIndex);
      for (let cursor = pathIndex; !matched && cursor < normalizedPath.length; cursor += 1) {
        if (!isDoubleStar && normalizedPath[cursor] === "/") break;
        matched = match(cursor + 1, nextPatternIndex);
      }
    } else if (
      pathIndex < normalizedPath.length &&
      (normalizedPattern[patternIndex] === "?" || normalizedPattern[patternIndex] === normalizedPath[pathIndex])
    ) {
      matched = match(pathIndex + 1, patternIndex + 1);
    } else {
      matched = false;
    }

    memo.set(memoKey, matched);
    return matched;
  }

  return match(0, 0);
}

export function isTelegramLoadGuardDependency(path: string): boolean {
  return TELEGRAM_LOAD_GUARD_PATHS.some((pattern) => matchesTelegramLoadGuardPattern(path, pattern));
}

export function hasTelegramLoadGuardImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some(isTelegramLoadGuardDependency);
}
