import type { TelegramLoadCheckReport } from "../ci/check-telegram-load";

function formatDuration(seconds: number): string {
  if (seconds === 0) return "same run";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

export function parseTelegramLoadTargets(args: string[]): number[] | null {
  const index = args.indexOf("--target");
  if (index === -1) return null;
  const raw = args[index + 1];
  if (!raw) throw new Error("--target requires a comma-separated numeric value");
  const targets = raw.split(",").map((value) => Number(value.trim()));
  if (targets.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid --target value: ${raw}`);
  }
  return targets;
}

export function printTelegramLoadReport(report: TelegramLoadCheckReport): void {
  console.log("Synthetic Telegram load simulation");
  console.log(
    `Assumptions: authoritative pending delivery at ${report.assumptions.pendingDrainAttemptsPerRun} attempts/run, ${report.assumptions.cronIntervalSeconds / 60}m cron, ${report.assumptions.worstCasePlanningDelaySeconds / 60}m worst-case planning, ${report.assumptions.effectiveSendMessagesPerSecond} effective msg/s, ${report.assumptions.pendingTtlSeconds / 60}m risk TTL, ${report.assumptions.adminPendingTtlSeconds / 60}m admin TTL, ${(report.assumptions.minimumTtlMarginFraction * 100).toFixed(0)}% minimum margin.`,
  );
  console.log(
    `CPU budget: ${report.assumptions.dispatchCpuMs.toLocaleString()}ms cap, ceiling ${report.assumptions.cpuBudgetCeilingMs.toLocaleString()}ms (${report.assumptions.cpuBudgetSafetyFraction}x), ${report.assumptions.formatCpuMsPerChat}ms/format-chat, ${report.assumptions.sendCpuMsPerMessage}ms/sent-chunk (format-count capped at fresh budget post-C102).`,
  );
  console.log("");

  for (const summary of report.fixtureSummaries) {
    console.log(
      `Fixture ${summary.activeWatchers.toLocaleString()} active watchers: ${summary.directSubscriptions.toLocaleString()} direct subs, ${summary.presetFollowers.toLocaleString()} preset followers, ${summary.groupChats.toLocaleString()} groups, ${summary.quietHoursChats.toLocaleString()} quiet-hours chats, ${summary.chatSnoozes.toLocaleString()} chat snoozes, ${summary.perCoinSnoozes.toLocaleString()} per-coin snoozes, ${summary.blockedChats.toLocaleString()} blocked chats.`,
    );
    console.log(
      `  Global opt-ins: depeg ${summary.globalOptIns.depeg.toLocaleString()}, dews ${summary.globalOptIns.dews.toLocaleString()}, safety ${summary.globalOptIns.safety.toLocaleString()}, launch ${summary.globalOptIns.launch.toLocaleString()}, reserve ${summary.globalOptIns.reserve.toLocaleString()}, freeze ${summary.globalOptIns.freeze.toLocaleString()}.`,
    );
  }

  console.log("");
  console.log("Scenario estimates:");
  for (const result of report.scenarios) {
    const slo = result.sloStatus.toUpperCase();
    console.log(
      `- ${result.targetActiveWatchers.toLocaleString()} / ${result.scenarioLabel}: ${result.targetChats.toLocaleString()} chats, ${result.messageChunks.toLocaleString()} chunks, planning ${formatDuration(result.planningDelaySeconds)}, unavailable ${formatDuration(result.outageUnavailableSeconds)}, post-recovery ${formatDuration(result.postRecoveryDrainSeconds)}, TTL margin ${(result.ttlMarginFraction * 100).toFixed(1)}%, CPU ~${result.estimatedCpuMs.toLocaleString()}ms, D1 ~${result.d1Operations.reads.toLocaleString()} reads / ${result.d1Operations.writes.toLocaleString()} writes [${slo}]`,
    );
  }

  if (report.queryPlans.length > 0) {
    console.log("");
    console.log("Query-plan checks:");
    for (const plan of report.queryPlans) {
      const suffix = plan.note ? ` (${plan.note})` : "";
      console.log(`- ${plan.status.toUpperCase()} ${plan.id}: ${plan.details.join(" | ")}${suffix}`);
    }
  }

  if (report.statusPathBudgets.length > 0) {
    console.log("");
    console.log("Status-path budgets (reviewed maxima at the planning target):");
    for (const budget of report.statusPathBudgets) {
      console.log(
        `- ${budget.status.toUpperCase()} ${budget.id} @ ${budget.targetActiveWatchers.toLocaleString()} watchers: rows read ${budget.rowsRead.toLocaleString()}/${budget.maxRowsRead.toLocaleString()}, duration ${budget.durationMs}ms/${budget.maxDurationMs}ms`,
      );
    }
  }
}
