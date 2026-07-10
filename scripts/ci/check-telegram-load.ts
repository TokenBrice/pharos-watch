import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  estimateTelegramTargetPlanCoordinatorBound,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  TELEGRAM_DISPATCH_TIMEOUT_MS,
  TELEGRAM_LOAD_GUARD_ASSUMPTIONS,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "../../shared/lib/telegram-delivery-policy";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

type AlertType = "depeg" | "dews" | "safety" | "launch" | "reserve";
type ScenarioId = "single-depeg" | "market-wide-burst" | "dews-safety-burst" | "admin-broadcast" | "telegram-429-storm";
type SloStatus = "ok" | "slow" | "breach" | "outage-unavailable" | "exploratory";
type QueryPlanStatus = "ok" | "review" | "fail";

interface AlertFlags {
  depeg: boolean;
  dews: boolean;
  safety: boolean;
  launch: boolean;
  reserve: boolean;
}

interface DirectSubscription {
  stablecoinId: string;
  flags: AlertFlags;
  snoozed: boolean;
}

interface PresetSubscription {
  presetId: keyof typeof PRESET_MEMBERS;
  flags: Omit<AlertFlags, "launch" | "reserve">;
}

interface SyntheticWatcher {
  chatId: string;
  kind: "private" | "group";
  quietHours: boolean;
  chatSnoozed: boolean;
  blocked: boolean;
  globals: AlertFlags;
  directSubscriptions: DirectSubscription[];
  presetSubscriptions: PresetSubscription[];
}

export interface SyntheticTelegramFixture {
  activeWatchers: number;
  watchers: SyntheticWatcher[];
}

export interface SyntheticFixtureSummary {
  activeWatchers: number;
  directSubscriptions: number;
  globalOptIns: Record<AlertType, number>;
  presetFollowers: number;
  groupChats: number;
  quietHoursChats: number;
  chatSnoozes: number;
  perCoinSnoozes: number;
  blockedChats: number;
  deliverableWatchers: number;
}

interface EventSpec {
  alertType: AlertType;
  stablecoinId: string;
}

interface ChatHit {
  chatId: string;
  kind: "private" | "group";
  quietHours: boolean;
  blocked: boolean;
  hitKeys: Set<string>;
}

interface D1OperationEstimate {
  reads: number;
  writes: number;
  notes: string[];
}

export interface LoadScenarioResult {
  targetActiveWatchers: number;
  scenarioId: ScenarioId;
  scenarioLabel: string;
  targetChats: number;
  targetGroups: number;
  quietHourDeliveries: number;
  blockedAttempts: number;
  messageChunks: number;
  initialFreshAttempts: number;
  pendingEnqueued: number;
  pendingDrainRuns: number;
  planningDelaySeconds: number;
  outageUnavailableSeconds: number;
  postRecoveryDrainSeconds: number;
  estimatedDrainSeconds: number;
  ttlSeconds: number;
  ttlMarginSeconds: number;
  ttlMarginFraction: number;
  /** Modelled per-invocation CPU after the C102 budget-before-format reorder. */
  estimatedCpuMs: number;
  d1Operations: D1OperationEstimate;
  sloStatus: SloStatus;
  exploratory: boolean;
}

interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface QueryPlanCheckDefinition {
  id: string;
  category: "fan-out" | "pulse-status" | "pending-drain" | "lifecycle";
  sql: string;
  binds: Array<string | number | null>;
  requiredDetails?: string[];
  allowedFullScanTables?: string[];
  note?: string;
}

export interface QueryPlanCheckResult {
  id: string;
  category: QueryPlanCheckDefinition["category"];
  status: QueryPlanStatus;
  details: string[];
  missingRequiredDetails: string[];
  unexpectedFullScanTables: string[];
  note?: string;
}

export interface TelegramLoadCheckReport {
  assumptions: {
    freshAttemptsPerRun: number;
    pendingDrainAttemptsPerRun: number;
    cronIntervalSeconds: number;
    dispatchTimeoutSeconds: number;
    sendLoopSoftDeadlineSeconds: number;
    telegramBroadcastMessagesPerSecond: number;
    telegramP95SendLatencyMs: number;
    effectiveSendMessagesPerSecond: number;
    d1WriteMsPerMessage: number;
    pendingTtlSeconds: number;
    adminPendingTtlSeconds: number;
    worstCasePlanningDelaySeconds: number;
    minimumTtlMarginFraction: number;
    normalSloSeconds: number;
    spikeMaxSeconds: number;
    dispatchCpuMs: number;
    cpuBudgetSafetyFraction: number;
    cpuBudgetCeilingMs: number;
    formatCpuMsPerChat: number;
    sendCpuMsPerMessage: number;
  };
  fixtureSummaries: SyntheticFixtureSummary[];
  scenarios: LoadScenarioResult[];
  queryPlans: QueryPlanCheckResult[];
}

const {
  watcherTargets: WATCHER_TARGETS,
  requiredTarget: REQUIRED_TARGET,
  exploratoryTarget: EXPLORATORY_TARGET,
  telegramBroadcastMessagesPerSecond: TELEGRAM_BROADCAST_MESSAGES_PER_SECOND,
  telegramP95SendLatencyMs: TELEGRAM_P95_SEND_LATENCY_MS,
  d1WriteMsPerMessage: D1_WRITE_MS_PER_MESSAGE,
  normalSloSeconds: NORMAL_SLO_SECONDS,
  spikeMaxSeconds: SPIKE_MAX_SECONDS,
  telegram429StormSeconds: TELEGRAM_429_STORM_SECONDS,
  minimumTtlMarginFraction: MINIMUM_TTL_MARGIN_FRACTION,
  defaultDispatchCpuMs: DEFAULT_DISPATCH_CPU_MS,
  cpuBudgetSafetyFraction: CPU_BUDGET_SAFETY_FRACTION,
  formatCpuMsPerChat: FORMAT_CPU_MS_PER_CHAT,
  sendCpuMsPerMessage: SEND_CPU_MS_PER_MESSAGE,
} = TELEGRAM_LOAD_GUARD_ASSUMPTIONS;

const FRESH_ATTEMPTS_PER_RUN = TELEGRAM_MAX_MESSAGES_PER_RUN;
const PENDING_DRAIN_ATTEMPTS_PER_RUN = TELEGRAM_PENDING_DRAIN_BUDGET;
const DISPATCH_TIMEOUT_SECONDS = TELEGRAM_DISPATCH_TIMEOUT_MS / 1000;
const SEND_LOOP_SOFT_DEADLINE_SECONDS = TELEGRAM_DISPATCH_SOFT_DEADLINE_MS / 1000;
const RISK_ALERT_PRIORITY = TELEGRAM_PENDING_PRIORITY.riskAlert;
const LEGACY_PENDING_PRIORITY = TELEGRAM_PENDING_PRIORITY.legacy;
const CRON_INTERVAL_SECONDS = TELEGRAM_DISPATCH_INTERVAL_SEC;
const PENDING_TTL_SECONDS = PENDING_TTL_SEC;
const ADMIN_PENDING_TTL_SECONDS = TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
const ALERTS_PER_MESSAGE_CHUNK = TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE;

// ---------- C102: per-invocation CPU budget modelling ----------

/**
 * Read the dispatcher CPU cap from `worker/wrangler.toml`, falling back to the
 * documented constant. Keeps the harness in step with the deployed limit.
 */
function readDispatchCpuMs(wranglerPath = resolve("worker/wrangler.toml")): number {
  try {
    const toml = readFileSync(wranglerPath, "utf8");
    const match = toml.match(/^\s*cpu_ms\s*=\s*(\d+)/m);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // fall through to the documented default
  }
  return DEFAULT_DISPATCH_CPU_MS;
}

const DISPATCH_CPU_MS = readDispatchCpuMs();
const CPU_BUDGET_CEILING_MS = DISPATCH_CPU_MS * CPU_BUDGET_SAFETY_FRACTION;

/**
 * Estimate per-invocation CPU for a scenario AFTER the C102 budget-before-format
 * reorder: at most `FRESH_ATTEMPTS_PER_RUN` chats are formatted on the hot path,
 * and only the fresh-sent chunks incur send cost in the same invocation.
 */
function estimateCpuMs(args: { messageChunks: number; initialFreshAttempts: number }): number {
  const formattedChats = Math.min(args.messageChunks, FRESH_ATTEMPTS_PER_RUN);
  const formatMs = formattedChats * FORMAT_CPU_MS_PER_CHAT;
  const sendMs = args.initialFreshAttempts * SEND_CPU_MS_PER_MESSAGE;
  return Math.round(formatMs + sendMs);
}

/**
 * Required-target scenarios whose modeled per-invocation CPU exceeds the safety
 * fraction of the cap. Exported so the C102 CPU gate is unit-testable without
 * driving `main()`/`process.exit`.
 */
export function findCpuBudgetBreaches(report: TelegramLoadCheckReport): LoadScenarioResult[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      scenario.estimatedCpuMs > report.assumptions.cpuBudgetCeilingMs,
  );
}

export function findTtlMarginBreaches(report: TelegramLoadCheckReport): LoadScenarioResult[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      !scenario.exploratory &&
      scenario.ttlMarginFraction < report.assumptions.minimumTtlMarginFraction,
  );
}
const EFFECTIVE_SEND_MESSAGES_PER_SECOND = Math.min(
  TELEGRAM_BROADCAST_MESSAGES_PER_SECOND,
  SEND_BATCH_SIZE / ((TELEGRAM_P95_SEND_LATENCY_MS + D1_WRITE_MS_PER_MESSAGE) / 1000),
);

const HOT_COIN_IDS = [
  "usdc-circle",
  "usdt-tether",
  "usd1-world-liberty-financial",
  "rlusd-ripple",
  "u-united-stables",
  "usde-ethena",
  "usdg-paxos",
  "usds-sky",
  "pyusd-paypal",
  "dai-makerdao",
  "frax-frax",
  "lusd-liquity",
  "usdp-paxos",
  "gusd-gemini",
  "tusd-trueusd",
  "fdusd-first-digital",
  "susde-ethena",
  "usdy-ondo",
  "usyc-circle",
  "eurt-tether",
  "eurc-circle",
  "eurs-stasis",
  "paxg-paxos",
  "xaut-tether",
  "gyen-gyen",
] as const;

const DIRECT_COIN_POOL = [
  // top-10 coins appear 3x to mimic hot-coin subscription concentration
  ...HOT_COIN_IDS.slice(0, 10),
  ...HOT_COIN_IDS.slice(0, 10),
  ...HOT_COIN_IDS.slice(0, 10),
  ...HOT_COIN_IDS.slice(10),
] as const;

const PRESET_MEMBERS = {
  "usd-top10": HOT_COIN_IDS.slice(0, 10),
  "usd-top25": HOT_COIN_IDS.slice(0, 25),
  // Mirrors the production "usd-top50" preset id (worker/src/lib/telegram-presets.ts);
  // the fixture pool only has 25 hot ids, so this currently resolves to the same set as usd-top25.
  "usd-top50": HOT_COIN_IDS.slice(0, 25),
  "eur-top10": ["eurt-tether", "eurc-circle", "eurs-stasis"],
  "gold-top5": ["paxg-paxos", "xaut-tether"],
  "mcap-ge-1b": HOT_COIN_IDS.slice(0, 12),
  "mcap-ge-100m": HOT_COIN_IDS.slice(0, 20),
} as const;

const PRESET_IDS = Object.keys(PRESET_MEMBERS) as Array<keyof typeof PRESET_MEMBERS>;

function hasAlertFlag(flags: AlertFlags | Omit<AlertFlags, "launch" | "reserve">, alertType: AlertType): boolean {
  if (alertType === "launch" || alertType === "reserve") return false;
  return flags[alertType] === true;
}

function mergeFlags(left: AlertFlags, right: AlertFlags): AlertFlags {
  return {
    depeg: left.depeg || right.depeg,
    dews: left.dews || right.dews,
    safety: left.safety || right.safety,
    launch: left.launch || right.launch,
    reserve: left.reserve || right.reserve,
  };
}

function buildDirectFlags(i: number, j: number): AlertFlags {
  return {
    depeg: (i + j) % 10 !== 0,
    dews: (i + 2 * j) % 3 === 0,
    safety: (i + j) % 4 === 0,
    launch: (i + j) % 19 === 0,
    reserve: (i + j) % 23 === 0,
  };
}

function buildGlobalFlags(i: number): AlertFlags {
  return {
    depeg: i % 2 === 0 || i % 13 === 0,
    dews: i % 29 === 0,
    safety: i % 14 === 0,
    launch: i % 101 === 0,
    reserve: i % 67 === 0,
  };
}

function buildDirectSubscriptions(i: number): DirectSubscription[] {
  const byCoin = new Map<string, DirectSubscription>();
  const directCount = 3 + (i % 8);
  for (let j = 0; j < directCount; j += 1) {
    const stablecoinId = DIRECT_COIN_POOL[(i * 17 + j * 11) % DIRECT_COIN_POOL.length]!;
    const next: DirectSubscription = {
      stablecoinId,
      flags: buildDirectFlags(i, j),
      snoozed: (i + j * 3) % 53 === 0,
    };
    const existing = byCoin.get(stablecoinId);
    if (existing) {
      existing.flags = mergeFlags(existing.flags, next.flags);
      existing.snoozed = existing.snoozed || next.snoozed;
    } else {
      byCoin.set(stablecoinId, next);
    }
  }
  return [...byCoin.values()];
}

function buildPresetSubscriptions(i: number): PresetSubscription[] {
  if (i % 12 !== 0) return [];
  const presetId = PRESET_IDS[(i / 12) % PRESET_IDS.length]!;
  return [
    {
      presetId,
      flags: {
        depeg: true,
        dews: i % 24 === 0,
        safety: i % 36 === 0,
      },
    },
  ];
}

export function buildSyntheticTelegramFixture(activeWatchers: number): SyntheticTelegramFixture {
  const watchers: SyntheticWatcher[] = [];
  for (let i = 0; i < activeWatchers; i += 1) {
    watchers.push({
      chatId: `synthetic-${String(i + 1).padStart(6, "0")}`,
      kind: i % 7 === 0 ? "group" : "private",
      quietHours: i % 16 === 0,
      chatSnoozed: i % 37 === 0,
      blocked: i % 89 === 0,
      globals: buildGlobalFlags(i),
      directSubscriptions: buildDirectSubscriptions(i),
      presetSubscriptions: buildPresetSubscriptions(i),
    });
  }
  return { activeWatchers, watchers };
}

function hasDeliverableState(watcher: SyntheticWatcher): boolean {
  return (
    watcher.globals.depeg ||
    watcher.globals.dews ||
    watcher.globals.safety ||
    watcher.globals.launch ||
    watcher.globals.reserve ||
    watcher.directSubscriptions.some((sub) => sub.flags.depeg || sub.flags.dews || sub.flags.safety || sub.flags.launch || sub.flags.reserve) ||
    watcher.presetSubscriptions.some((preset) => preset.flags.depeg || preset.flags.dews || preset.flags.safety)
  );
}

export function summarizeFixture(fixture: SyntheticTelegramFixture): SyntheticFixtureSummary {
  const globalOptIns: Record<AlertType, number> = { depeg: 0, dews: 0, safety: 0, launch: 0, reserve: 0 };
  let directSubscriptions = 0;
  let presetFollowers = 0;
  let groupChats = 0;
  let quietHoursChats = 0;
  let chatSnoozes = 0;
  let perCoinSnoozes = 0;
  let blockedChats = 0;
  let deliverableWatchers = 0;

  for (const watcher of fixture.watchers) {
    directSubscriptions += watcher.directSubscriptions.length;
    presetFollowers += watcher.presetSubscriptions.length > 0 ? 1 : 0;
    groupChats += watcher.kind === "group" ? 1 : 0;
    quietHoursChats += watcher.quietHours ? 1 : 0;
    chatSnoozes += watcher.chatSnoozed ? 1 : 0;
    blockedChats += watcher.blocked ? 1 : 0;
    deliverableWatchers += hasDeliverableState(watcher) ? 1 : 0;
    for (const sub of watcher.directSubscriptions) {
      perCoinSnoozes += sub.snoozed ? 1 : 0;
    }
    for (const type of Object.keys(globalOptIns) as AlertType[]) {
      globalOptIns[type] += watcher.globals[type] ? 1 : 0;
    }
  }

  return {
    activeWatchers: fixture.activeWatchers,
    directSubscriptions,
    globalOptIns,
    presetFollowers,
    groupChats,
    quietHoursChats,
    chatSnoozes,
    perCoinSnoozes,
    blockedChats,
    deliverableWatchers,
  };
}

function addHit(hitsByChat: Map<string, ChatHit>, watcher: SyntheticWatcher, event: EventSpec): void {
  const existing = hitsByChat.get(watcher.chatId) ?? {
    chatId: watcher.chatId,
    kind: watcher.kind,
    quietHours: watcher.quietHours,
    blocked: watcher.blocked,
    hitKeys: new Set<string>(),
  };
  existing.hitKeys.add(`${event.alertType}:${event.stablecoinId}`);
  hitsByChat.set(watcher.chatId, existing);
}

function hasActivePerCoinSnooze(watcher: SyntheticWatcher, stablecoinId: string): boolean {
  return watcher.directSubscriptions.some((sub) => sub.stablecoinId === stablecoinId && sub.snoozed);
}

function hasDirectMatch(watcher: SyntheticWatcher, event: EventSpec): boolean {
  return watcher.directSubscriptions.some(
    (sub) =>
      sub.stablecoinId === event.stablecoinId &&
      !sub.snoozed &&
      sub.flags[event.alertType],
  );
}

function hasPresetMatch(watcher: SyntheticWatcher, event: EventSpec): boolean {
  if (event.alertType === "launch" || event.alertType === "reserve") return false;
  return watcher.presetSubscriptions.some(
    (preset) => {
      const presetMembers: readonly string[] = PRESET_MEMBERS[preset.presetId];
      return hasAlertFlag(preset.flags, event.alertType) && presetMembers.includes(event.stablecoinId);
    },
  );
}

function collectEventHits(fixture: SyntheticTelegramFixture, events: EventSpec[]): Map<string, ChatHit> {
  const hitsByChat = new Map<string, ChatHit>();
  for (const watcher of fixture.watchers) {
    if (watcher.chatSnoozed) continue;
    for (const event of events) {
      if (hasActivePerCoinSnooze(watcher, event.stablecoinId)) continue;
      const specificMatch = hasDirectMatch(watcher, event) || hasPresetMatch(watcher, event);
      const globalMatch = watcher.globals[event.alertType];
      if (specificMatch || globalMatch) {
        addHit(hitsByChat, watcher, event);
      }
    }
  }
  return hitsByChat;
}

function estimateMessageChunks(hitsByChat: Map<string, ChatHit>): number {
  let chunks = 0;
  for (const hit of hitsByChat.values()) {
    chunks += Math.max(1, Math.ceil(hit.hitKeys.size / ALERTS_PER_MESSAGE_CHUNK));
  }
  return chunks;
}

function countBlockedMessageChunks(hitsByChat: Map<string, ChatHit>): number {
  let chunks = 0;
  for (const hit of hitsByChat.values()) {
    if (!hit.blocked) continue;
    chunks += Math.max(1, Math.ceil(hit.hitKeys.size / ALERTS_PER_MESSAGE_CHUNK));
  }
  return chunks;
}

function estimateRiskD1Ops(args: {
  fanoutReadQueries: number;
  messages: number;
  blockedMessages: number;
  pendingEnqueued: number;
  pendingDrainRuns: number;
  alertJobCount: number;
  stormRetryWrites?: number;
}): D1OperationEstimate {
  const sentOrAttempted = args.messages;
  const successfulResetWrites = Math.max(0, sentOrAttempted - args.blockedMessages);
  const blockedStrikeWrites = args.blockedMessages;
  const pendingDeleteBatches = args.pendingDrainRuns;
  const reads = args.fanoutReadQueries + 1 + args.pendingDrainRuns;
  const writes =
    args.messages +
    args.alertJobCount * 2 +
    args.pendingEnqueued +
    successfulResetWrites +
    blockedStrikeWrites +
    pendingDeleteBatches +
    (args.stormRetryWrites ?? 0);

  return {
    reads,
    writes,
    notes: [
      "Read estimate counts fan-out groups, backoff/pending reads, and one pending SELECT per drain run.",
      "Write estimate counts alert job/target manifests, pending enqueues, success reset updates, blocked-strike updates, and pending delete batches.",
    ],
  };
}

function classifySlo(
  targetActiveWatchers: number,
  scenarioId: ScenarioId,
  postRecoverySeconds: number,
  outageUnavailableSeconds: number,
): SloStatus {
  if (targetActiveWatchers === EXPLORATORY_TARGET) return "exploratory";
  if (outageUnavailableSeconds > 0) return "outage-unavailable";
  if (scenarioId === "market-wide-burst" || scenarioId === "telegram-429-storm") {
    return postRecoverySeconds <= SPIKE_MAX_SECONDS ? "slow" : "breach";
  }
  return postRecoverySeconds <= NORMAL_SLO_SECONDS
    ? "ok"
    : postRecoverySeconds <= SPIKE_MAX_SECONDS ? "slow" : "breach";
}

function estimateSendSeconds(messageCount: number): number {
  if (messageCount <= 0) return 0;
  return Math.ceil(messageCount / EFFECTIVE_SEND_MESSAGES_PER_SECOND);
}

function buildScenarioResult(args: {
  fixture: SyntheticTelegramFixture;
  scenarioId: ScenarioId;
  scenarioLabel: string;
  hitsByChat: Map<string, ChatHit>;
  fanoutReadQueries: number;
  adminPendingOnly?: boolean;
  stormSeconds?: number;
}): LoadScenarioResult {
  const targetChats = args.hitsByChat.size;
  const targetGroups = [...args.hitsByChat.values()].filter((hit) => hit.kind === "group").length;
  const quietHourDeliveries = [...args.hitsByChat.values()].filter((hit) => hit.quietHours).length;
  const messageChunks = estimateMessageChunks(args.hitsByChat);
  const alertJobCount = new Set(
    [...args.hitsByChat.values()].flatMap((hit) =>
      [...hit.hitKeys]
        .map((key) => key.split(":")[0])
        .filter((key): key is AlertType => key === "depeg" || key === "dews" || key === "safety" || key === "launch" || key === "reserve"),
    ),
  ).size;
  const blockedAttempts = countBlockedMessageChunks(args.hitsByChat);
  // Production target manifests hand every delivery through the authoritative
  // pending lifecycle; the legacy direct-fresh sender is rollback-only.
  const initialFreshAttempts = 0;
  const pendingEnqueued = messageChunks;
  const pendingDrainRuns = Math.ceil(pendingEnqueued / PENDING_DRAIN_ATTEMPTS_PER_RUN);
  const pendingScheduleSeconds = pendingDrainRuns * CRON_INTERVAL_SECONDS;
  const pendingSendSeconds = estimateSendSeconds(pendingEnqueued);
  const postRecoveryDrainSeconds = Math.max(pendingScheduleSeconds, pendingSendSeconds);
  const planningDelaySeconds = args.adminPendingOnly
    ? 0
    : estimateTelegramTargetPlanCoordinatorBound({
      subscriberCount: args.fixture.activeWatchers,
      targetCount: messageChunks,
    }).runs * CRON_INTERVAL_SECONDS;
  const outageUnavailableSeconds = args.stormSeconds ?? 0;
  const estimatedDrainSeconds = planningDelaySeconds + outageUnavailableSeconds + postRecoveryDrainSeconds;
  const ttlSeconds = args.adminPendingOnly ? ADMIN_PENDING_TTL_SECONDS : PENDING_TTL_SECONDS;
  const ttlMarginSeconds = ttlSeconds - estimatedDrainSeconds;
  const ttlMarginFraction = ttlMarginSeconds / ttlSeconds;
  const stormRuns = args.stormSeconds ? Math.ceil(args.stormSeconds / CRON_INTERVAL_SECONDS) : 0;
  const stormRetryWrites = args.stormSeconds ? Math.min(messageChunks, stormRuns * 4) : 0;
  const d1Operations = args.adminPendingOnly
    ? {
        reads: 1 + pendingDrainRuns,
        writes: messageChunks + Math.max(0, messageChunks - blockedAttempts) + blockedAttempts + pendingDrainRuns,
        notes: [
          "Admin broadcast estimate counts one target enumeration read, pending enqueue rows, pending success/block updates, and delete batches.",
          `Telegram pacing assumes ${EFFECTIVE_SEND_MESSAGES_PER_SECOND.toFixed(1)} messages/sec from Bot API broadcast cap, ${SEND_BATCH_SIZE}-wide sends, p95 latency, and D1 write cost.`,
        ],
      }
    : estimateRiskD1Ops({
        fanoutReadQueries: args.fanoutReadQueries,
        messages: messageChunks,
        blockedMessages: blockedAttempts,
        pendingEnqueued,
        pendingDrainRuns,
        alertJobCount,
        stormRetryWrites,
      });

  return {
    targetActiveWatchers: args.fixture.activeWatchers,
    scenarioId: args.scenarioId,
    scenarioLabel: args.scenarioLabel,
    targetChats,
    targetGroups,
    quietHourDeliveries,
    blockedAttempts,
    messageChunks,
    initialFreshAttempts,
    pendingEnqueued,
    pendingDrainRuns,
    planningDelaySeconds,
    outageUnavailableSeconds,
    postRecoveryDrainSeconds,
    estimatedDrainSeconds,
    ttlSeconds,
    ttlMarginSeconds,
    ttlMarginFraction,
    estimatedCpuMs: estimateCpuMs({ messageChunks, initialFreshAttempts }),
    d1Operations,
    sloStatus: classifySlo(
      args.fixture.activeWatchers,
      args.scenarioId,
      postRecoveryDrainSeconds,
      outageUnavailableSeconds,
    ),
    exploratory: args.fixture.activeWatchers === EXPLORATORY_TARGET,
  };
}

function collectAdminBroadcastHits(fixture: SyntheticTelegramFixture): Map<string, ChatHit> {
  const hitsByChat = new Map<string, ChatHit>();
  for (const watcher of fixture.watchers) {
    if (!hasDeliverableState(watcher)) continue;
    hitsByChat.set(watcher.chatId, {
      chatId: watcher.chatId,
      kind: watcher.kind,
      quietHours: watcher.quietHours,
      blocked: watcher.blocked,
      hitKeys: new Set(["admin-broadcast"]),
    });
  }
  return hitsByChat;
}

export function simulateLoadScenarios(fixture: SyntheticTelegramFixture): LoadScenarioResult[] {
  const singleDepegEvents: EventSpec[] = [{ alertType: "depeg", stablecoinId: "usdc-circle" }];
  const marketWideEvents: EventSpec[] = HOT_COIN_IDS.slice(0, 25).map((stablecoinId) => ({
    alertType: "depeg",
    stablecoinId,
  }));
  const dewsSafetyEvents: EventSpec[] = [
    ...HOT_COIN_IDS.slice(0, 12).map((stablecoinId) => ({ alertType: "dews" as const, stablecoinId })),
    ...HOT_COIN_IDS.slice(5, 15).map((stablecoinId) => ({ alertType: "safety" as const, stablecoinId })),
    ...HOT_COIN_IDS.slice(10, 20).map((stablecoinId) => ({ alertType: "reserve" as const, stablecoinId })),
  ];

  return [
    buildScenarioResult({
      fixture,
      scenarioId: "single-depeg",
      scenarioLabel: "Single USDC depeg",
      hitsByChat: collectEventHits(fixture, singleDepegEvents),
      fanoutReadQueries: 5,
    }),
    buildScenarioResult({
      fixture,
      scenarioId: "market-wide-burst",
      scenarioLabel: "Market-wide 25-coin depeg burst",
      hitsByChat: collectEventHits(fixture, marketWideEvents),
      fanoutReadQueries: 5,
    }),
    buildScenarioResult({
      fixture,
      scenarioId: "dews-safety-burst",
      scenarioLabel: "DEWS, safety-grade, and reserve burst",
      hitsByChat: collectEventHits(fixture, dewsSafetyEvents),
      fanoutReadQueries: 11,
    }),
    buildScenarioResult({
      fixture,
      scenarioId: "admin-broadcast",
      scenarioLabel: "Admin broadcast to deliverable watchers",
      hitsByChat: collectAdminBroadcastHits(fixture),
      fanoutReadQueries: 1,
      adminPendingOnly: true,
    }),
    buildScenarioResult({
      fixture,
      scenarioId: "telegram-429-storm",
      scenarioLabel: "Telegram 429 storm against market-wide burst",
      hitsByChat: collectEventHits(fixture, marketWideEvents),
      fanoutReadQueries: 5,
      stormSeconds: TELEGRAM_429_STORM_SECONDS,
    }),
  ];
}

function runExplainQueryPlan(db: DatabaseSync, check: QueryPlanCheckDefinition): QueryPlanCheckResult {
  // Cast: better-sqlite3 .all() returns unknown[]; EXPLAIN QUERY PLAN's row shape is stable per SQLite docs
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${check.sql}`).all(...check.binds) as unknown as QueryPlanRow[];
  const details = rows.map((row) => row.detail);
  return evaluateQueryPlan(check, details);
}

function getFullScanTable(detail: string): string | null {
  if (!detail.startsWith("SCAN ")) return null;
  if (detail.includes(" USING INDEX ") || detail.includes(" USING COVERING INDEX ")) return null;
  const rest = detail.slice("SCAN ".length).trim();
  const [table] = rest.split(" ");
  return table || null;
}

export function evaluateQueryPlan(
  check: QueryPlanCheckDefinition,
  details: string[],
): QueryPlanCheckResult {
  const requiredDetails = check.requiredDetails ?? [];
  const missingRequiredDetails = requiredDetails.filter(
    (required) => !details.some((detail) => detail.includes(required)),
  );
  const allowedFullScanTables = new Set(check.allowedFullScanTables ?? []);
  const unexpectedFullScanTables = new Set<string>();

  for (const detail of details) {
    const table = getFullScanTable(detail);
    if (!table) continue;
    if (!allowedFullScanTables.has(table)) {
      unexpectedFullScanTables.add(table);
    }
  }

  const status: QueryPlanStatus = missingRequiredDetails.length > 0 || unexpectedFullScanTables.size > 0
    ? "fail"
    : check.allowedFullScanTables && check.allowedFullScanTables.length > 0
      ? "review"
      : "ok";

  return {
    id: check.id,
    category: check.category,
    status,
    details,
    missingRequiredDetails,
    unexpectedFullScanTables: [...unexpectedFullScanTables],
    note: check.note,
  };
}

export function buildQueryPlanChecks(): QueryPlanCheckDefinition[] {
  const activeSubscriptionCountsSql = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
              OR alert_launch = 1
              OR alert_reserve = 1
            THEN 1 ELSE 0
          END
        ) AS active_sub_count
   FROM telegram_subscriptions
  GROUP BY chat_id`;
  const activeWatcherCondition = `s.global_alert_dews = 1
  OR s.global_alert_depeg = 1
  OR s.global_alert_safety = 1
  OR s.global_alert_launch = 1
  OR s.global_alert_reserve = 1
  OR COALESCE(sub.active_sub_count, 0) > 0`;

  return [
    {
      id: "fanout-direct-depeg",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_depeg = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_coin", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-global-depeg",
      category: "fan-out",
      sql: `SELECT chat_id, last_active_at
         FROM telegram_subscribers
        WHERE global_alert_depeg = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
      binds: [1_800_000_000],
      requiredDetails: ["idx_telegram_subscribers_global_alert_depeg"],
    },
    {
      id: "fanout-preset-depeg",
      category: "fan-out",
      sql: `SELECT p.chat_id, p.preset_id, u.last_active_at
         FROM telegram_preset_subscriptions p
         JOIN telegram_subscribers u ON u.chat_id = p.chat_id
        WHERE p.alert_depeg = 1
          AND p.preset_id IN (?, ?)
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`,
      binds: ["usd-top25", "mcap-ge-1b", 1_800_000_000],
      requiredDetails: ["idx_telegram_preset_subscriptions_preset", "sqlite_autoindex_telegram_subscribers_1"],
      note: "Preset fan-out resolves preset definitions before querying and restricts subscriber rows to matching preset ids.",
    },
    {
      id: "fanout-per-coin-snooze",
      category: "fan-out",
      sql: `SELECT stablecoin_id, chat_id
         FROM telegram_subscriptions
        WHERE stablecoin_id IN (?, ?, ?)
          AND alert_snooze_until_ts IS NOT NULL
          AND alert_snooze_until_ts > ?`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000],
      requiredDetails: ["idx_tg_sub_coin"],
    },
    {
      id: "fanout-direct-reserve",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_reserve = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_coin", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-global-reserve",
      category: "fan-out",
      sql: `SELECT chat_id, last_active_at
         FROM telegram_subscribers
        WHERE global_alert_reserve = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
      binds: [1_800_000_000],
      requiredDetails: ["idx_telegram_subscribers_global_alert_reserve"],
    },
    {
      id: "pending-claim-ready",
      category: "pending-drain",
      sql: `SELECT p.id, p.chat_id, p.message_html
         FROM telegram_pending_alerts p
        WHERE COALESCE(p.expires_at, p.created_at + ?) > ?
          AND (p.not_before_at IS NULL OR p.not_before_at <= ?)
          AND (? IS NULL OR COALESCE(p.priority, ?) <= ?)
          AND (
            p.processing_owner IS NULL
            OR p.processing_expires_at IS NULL
            OR p.processing_expires_at <= ?
          )
        ORDER BY COALESCE(p.priority, ?) ASC,
                 COALESCE(p.not_before_at, p.created_at) ASC,
                 p.created_at ASC,
                 p.chunk_index ASC
        LIMIT ?`,
      binds: [
        PENDING_TTL_SECONDS,
        1_800_000_000,
        1_800_000_000,
        RISK_ALERT_PRIORITY,
        LEGACY_PENDING_PRIORITY,
        RISK_ALERT_PRIORITY,
        1_800_000_000,
        LEGACY_PENDING_PRIORITY,
        PENDING_DRAIN_ATTEMPTS_PER_RUN,
      ],
      requiredDetails: ["idx_tpa_ready", "idx_tpa_not_before"],
      note: "Mirrors selectPendingClaimCandidateIds() in telegram-pending/drain.ts (migration 0124 claim columns). SQLite serves this via a multi-index OR on idx_tpa_ready/idx_tpa_not_before rather than idx_tpa_claim_ready; this guards the claim drain against a regression to a full table scan once the 0124 schema is loaded.",
    },
    {
      id: "pending-backoff-aggregate",
      category: "pending-drain",
      sql: `SELECT chat_id, MAX(not_before_at) AS not_before_at
         FROM telegram_pending_alerts
        WHERE created_at >= ?
          AND not_before_at IS NOT NULL
          AND not_before_at > ?
        GROUP BY chat_id`,
      binds: [1_799_996_400, 1_800_000_000],
      requiredDetails: ["idx_telegram_pending_alerts_chat_id"],
    },
    {
      id: "pulse-aggregate",
      category: "pulse-status",
      sql: `SELECT
             SUM(CASE WHEN s.global_alert_dews = 1
                   OR s.global_alert_depeg = 1
                   OR s.global_alert_safety = 1
                   OR s.global_alert_launch = 1
                   OR s.global_alert_reserve = 1
                   OR COALESCE(sub.active_sub_count, 0) > 0
                 THEN 1 ELSE 0 END) AS active_watchers
           FROM telegram_subscribers s
           LEFT JOIN (
             SELECT chat_id,
                    SUM(CASE WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 OR alert_launch = 1 OR alert_reserve = 1 THEN 1 ELSE 0 END) AS active_sub_count
               FROM telegram_subscriptions
              GROUP BY chat_id
           ) sub ON sub.chat_id = s.chat_id`,
      binds: [],
      allowedFullScanTables: ["s"],
      note: "Pulse common path serves telegram:pulse:snapshot from cache; this reviews the refresh/fallback aggregate query.",
    },
    {
      id: "status-top-stablecoins",
      category: "pulse-status",
      sql: `SELECT stablecoin_id, COUNT(*) AS subscribers
        FROM telegram_subscriptions
       WHERE alert_dews = 1
          OR alert_depeg = 1
          OR alert_safety = 1
          OR alert_launch = 1
          OR alert_reserve = 1
       GROUP BY stablecoin_id
       ORDER BY subscribers DESC, stablecoin_id ASC
       LIMIT 5`,
      binds: [],
      allowedFullScanTables: ["telegram_subscriptions"],
      note: "Top-coin status is still an aggregate over current subscriptions; reviewed until a dedicated status snapshot exists.",
    },
    {
      id: "lifecycle-current-active-history",
      category: "lifecycle",
      sql: `SELECT
             date(s.created_at, 'unixepoch') AS day,
             strftime('%s', date(s.created_at, 'unixepoch')) AS day_ts,
             COUNT(*) AS new_watchers
           FROM telegram_subscribers s
           LEFT JOIN (
             ${activeSubscriptionCountsSql}
           ) sub ON sub.chat_id = s.chat_id
           WHERE ${activeWatcherCondition}
           GROUP BY day
           ORDER BY day ASC`,
      binds: [],
      allowedFullScanTables: ["s"],
      note: "Legacy fallback history still scans subscribers only when lifecycle snapshots are missing; production history uses telegram_watcher_lifecycle_daily once populated.",
    },
  ];
}

// Telegram migrations depend on shared Worker schema (for example effect
// fencing depends on scheduler tables), so this fixture replays the same full
// ordered stream as production instead of guessing dependencies by filename.
const MIN_TELEGRAM_PLAN_MIGRATIONS = 120;

function selectTelegramPlanMigrations(migrationsDir: string): string[] {
  // Mirrors getMigrationFiles() in check-worker-migrations.mjs, inlined to
  // avoid pulling that module's top-level await into this tsx-transformed CLI.
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function createTelegramPlanDatabase(migrationsDir = resolve("worker/migrations")): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const migrationFiles = selectTelegramPlanMigrations(migrationsDir);
  if (migrationFiles.length < MIN_TELEGRAM_PLAN_MIGRATIONS) {
    throw new Error(
      `Expected at least ${MIN_TELEGRAM_PLAN_MIGRATIONS} Telegram plan migrations, found ${migrationFiles.length}. ` +
        `Update MIN_TELEGRAM_PLAN_MIGRATIONS in check-telegram-load.ts if this is intentional.`,
    );
  }
  for (const file of migrationFiles) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

export function runQueryPlanChecks(migrationsDir?: string): QueryPlanCheckResult[] {
  const db = createTelegramPlanDatabase(migrationsDir);
  try {
    return buildQueryPlanChecks().map((check) => runExplainQueryPlan(db, check));
  } finally {
    db.close();
  }
}

export function buildTelegramLoadCheckReport(options: {
  targets?: readonly number[];
  skipQueryPlans?: boolean;
  migrationsDir?: string;
} = {}): TelegramLoadCheckReport {
  const targets = options.targets ?? WATCHER_TARGETS;
  const fixtures = targets.map((target) => buildSyntheticTelegramFixture(target));
  const scenarios = fixtures.flatMap((fixture) => simulateLoadScenarios(fixture));
  const requiredPlanningScenarios = scenarios.filter(
    (scenario) => scenario.targetActiveWatchers === REQUIRED_TARGET,
  );
  const worstCasePlanningDelaySeconds = Math.max(
    0,
    ...(requiredPlanningScenarios.length > 0 ? requiredPlanningScenarios : scenarios)
      .map((scenario) => scenario.planningDelaySeconds),
  );
  return {
    assumptions: {
      freshAttemptsPerRun: FRESH_ATTEMPTS_PER_RUN,
      pendingDrainAttemptsPerRun: PENDING_DRAIN_ATTEMPTS_PER_RUN,
      cronIntervalSeconds: CRON_INTERVAL_SECONDS,
      dispatchTimeoutSeconds: DISPATCH_TIMEOUT_SECONDS,
      sendLoopSoftDeadlineSeconds: SEND_LOOP_SOFT_DEADLINE_SECONDS,
      telegramBroadcastMessagesPerSecond: TELEGRAM_BROADCAST_MESSAGES_PER_SECOND,
      telegramP95SendLatencyMs: TELEGRAM_P95_SEND_LATENCY_MS,
      effectiveSendMessagesPerSecond: Math.round(EFFECTIVE_SEND_MESSAGES_PER_SECOND * 10) / 10,
      d1WriteMsPerMessage: D1_WRITE_MS_PER_MESSAGE,
      pendingTtlSeconds: PENDING_TTL_SECONDS,
      adminPendingTtlSeconds: ADMIN_PENDING_TTL_SECONDS,
      worstCasePlanningDelaySeconds,
      minimumTtlMarginFraction: MINIMUM_TTL_MARGIN_FRACTION,
      normalSloSeconds: NORMAL_SLO_SECONDS,
      spikeMaxSeconds: SPIKE_MAX_SECONDS,
      dispatchCpuMs: DISPATCH_CPU_MS,
      cpuBudgetSafetyFraction: CPU_BUDGET_SAFETY_FRACTION,
      cpuBudgetCeilingMs: CPU_BUDGET_CEILING_MS,
      formatCpuMsPerChat: FORMAT_CPU_MS_PER_CHAT,
      sendCpuMsPerMessage: SEND_CPU_MS_PER_MESSAGE,
    },
    fixtureSummaries: fixtures.map(summarizeFixture),
    scenarios,
    queryPlans: options.skipQueryPlans ? [] : runQueryPlanChecks(options.migrationsDir),
  };
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "same run";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function parseTargets(args: string[]): number[] | null {
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

function printReport(report: TelegramLoadCheckReport): void {
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
      `  Global opt-ins: depeg ${summary.globalOptIns.depeg.toLocaleString()}, dews ${summary.globalOptIns.dews.toLocaleString()}, safety ${summary.globalOptIns.safety.toLocaleString()}, launch ${summary.globalOptIns.launch.toLocaleString()}, reserve ${summary.globalOptIns.reserve.toLocaleString()}.`,
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
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const skipQueryPlans = args.includes("--skip-query-plans");
  const enforceTargetSlo = args.includes("--enforce-target-slo");
  const targets = parseTargets(args) ?? WATCHER_TARGETS;
  const report = buildTelegramLoadCheckReport({ targets, skipQueryPlans });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const failedPlans = report.queryPlans.filter((plan) => plan.status === "fail");
  const normalTargetSloFailures = report.scenarios.filter(
    (scenario) =>
      enforceTargetSlo &&
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      (scenario.scenarioId === "single-depeg" || scenario.scenarioId === "dews-safety-burst") &&
      scenario.sloStatus !== "ok",
  );
  const spikeTargetSloBreaches = report.scenarios.filter(
    (scenario) =>
      enforceTargetSlo &&
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      (scenario.scenarioId === "market-wide-burst" || scenario.scenarioId === "telegram-429-storm") &&
      scenario.sloStatus === "breach",
  );
  // C102 gate: the required-target burst must stay under the CPU safety fraction
  // of the per-invocation cap. Always enforced (not gated on --enforce-target-slo).
  const cpuBudgetBreaches = findCpuBudgetBreaches(report);
  const ttlMarginBreaches = enforceTargetSlo ? findTtlMarginBreaches(report) : [];

  if (
    failedPlans.length > 0 ||
    normalTargetSloFailures.length > 0 ||
    spikeTargetSloBreaches.length > 0 ||
    cpuBudgetBreaches.length > 0 ||
    ttlMarginBreaches.length > 0
  ) {
    if (failedPlans.length > 0) {
      console.error(`\n${failedPlans.length} query-plan check(s) failed.`);
    }
    if (normalTargetSloFailures.length > 0) {
      console.error(
        `\n${normalTargetSloFailures.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher normal SLO scenario(s) were not OK.`,
      );
    }
    if (spikeTargetSloBreaches.length > 0) {
      console.error(
        `\n${spikeTargetSloBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher spike scenario(s) breached.`,
      );
    }
    if (cpuBudgetBreaches.length > 0) {
      console.error(
        `\n${cpuBudgetBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher scenario(s) exceeded the ${report.assumptions.cpuBudgetCeilingMs.toLocaleString()}ms CPU budget ceiling: ${cpuBudgetBreaches
          .map((scenario) => `${scenario.scenarioId} ~${scenario.estimatedCpuMs.toLocaleString()}ms`)
          .join(", ")}.`,
      );
    }
    if (ttlMarginBreaches.length > 0) {
      console.error(
        `\n${ttlMarginBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher scenario(s) missed the ${(MINIMUM_TTL_MARGIN_FRACTION * 100).toFixed(0)}% TTL margin: ${ttlMarginBreaches
          .map((scenario) => `${scenario.scenarioId} ${(scenario.ttlMarginFraction * 100).toFixed(1)}%`)
          .join(", ")}.`,
      );
    }
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
