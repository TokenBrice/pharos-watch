import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  estimateTelegramTargetPlanCoordinatorBound,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  TELEGRAM_DISPATCH_TIMEOUT_MS,
  TELEGRAM_HISTORICAL_SOURCE_PRIORITY,
  TELEGRAM_LOAD_GUARD_ASSUMPTIONS,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
  TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
} from "@shared/lib/telegram-delivery-policy";
type AlertType = "depeg" | "dews" | "safety" | "launch" | "reserve" | "freeze";
type ScenarioId = "single-depeg" | "market-wide-burst" | "dews-safety-burst" | "freeze-event" | "admin-broadcast" | "telegram-429-storm";
type SloStatus = "ok" | "slow" | "breach" | "outage-unavailable" | "exploratory";

interface AlertFlags {
  depeg: boolean;
  dews: boolean;
  safety: boolean;
  launch: boolean;
  reserve: boolean;
  freeze: boolean;
}

interface DirectSubscription {
  stablecoinId: string;
  flags: AlertFlags;
  snoozed: boolean;
}

interface PresetSubscription {
  presetId: keyof typeof PRESET_MEMBERS;
  flags: Omit<AlertFlags, "launch" | "reserve" | "freeze">;
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

export interface ProductionCalibratedDispatchScenario {
  subscriberCount: number;
  candidateSubscriberCount: number;
  targetCount: number;
  sourceEventCount: number;
  capturePageCount: number;
  planningPageCount: number;
  fanoutInputLoadCallCount: number;
  duplicatedFanoutInputLoadCallCount: number;
  handoffPageCount: number;
  handoffOperationCount: number;
  maxHandoffOperationsPerPage: number;
  coordinatorStepCount: number;
  estimatedInvocationWallMs: number;
  maxInvocationWallMs: number;
}
export const {
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
  productionDispatchSubscribers: PRODUCTION_DISPATCH_SUBSCRIBERS,
  productionDispatchCandidateSubscribers: PRODUCTION_DISPATCH_CANDIDATE_SUBSCRIBERS,
  productionDispatchTargets: PRODUCTION_DISPATCH_TARGETS,
  productionFanoutInputPageWallMs: PRODUCTION_FANOUT_INPUT_PAGE_WALL_MS,
  productionPlanningPageWallMs: PRODUCTION_PLANNING_PAGE_WALL_MS,
  productionHandoffOperationsPerPage: PRODUCTION_HANDOFF_OPERATIONS_PER_PAGE,
  productionHandoffOperationWallMs: PRODUCTION_HANDOFF_OPERATION_WALL_MS,
  productionSourcePresetWallMs: PRODUCTION_SOURCE_PRESET_WALL_MS,
  productionDispatchWallBudgetMs: PRODUCTION_DISPATCH_WALL_BUDGET_MS,
} = TELEGRAM_LOAD_GUARD_ASSUMPTIONS;

export const FRESH_ATTEMPTS_PER_RUN = TELEGRAM_MAX_MESSAGES_PER_RUN;
export const PENDING_DRAIN_ATTEMPTS_PER_RUN = TELEGRAM_PENDING_DRAIN_BUDGET;
export const DISPATCH_TIMEOUT_SECONDS = TELEGRAM_DISPATCH_TIMEOUT_MS / 1000;
export const SEND_LOOP_SOFT_DEADLINE_SECONDS = TELEGRAM_DISPATCH_SOFT_DEADLINE_MS / 1000;
export const RISK_ALERT_PRIORITY = TELEGRAM_PENDING_PRIORITY.riskAlert;
export const LEGACY_PENDING_PRIORITY = TELEGRAM_HISTORICAL_SOURCE_PRIORITY;
export const CRON_INTERVAL_SECONDS = TELEGRAM_DISPATCH_INTERVAL_SEC;
export const PENDING_TTL_SECONDS = PENDING_TTL_SEC;
export const ADMIN_PENDING_TTL_SECONDS = TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
const ALERTS_PER_MESSAGE_CHUNK = TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE;

export function simulateProductionCalibratedDispatch(): ProductionCalibratedDispatchScenario {
  const capturePageCount = Math.ceil(
    PRODUCTION_DISPATCH_CANDIDATE_SUBSCRIBERS / TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
  );
  const planningPageCount = capturePageCount;
  const fanoutInputLoadCallCount = capturePageCount;
  const handoffPageCount = Math.ceil(
    PRODUCTION_DISPATCH_TARGETS / TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
  );
  // Includes fixed source/expiry/selection/counter/remainder reads around the
  // set-based suppression, atomic handoff batch, and page confirmation.
  const handoffOperationCount = handoffPageCount * PRODUCTION_HANDOFF_OPERATIONS_PER_PAGE;
  const coordinatorStepCount = capturePageCount + planningPageCount + handoffPageCount + 2;
  const pendingDrainWallMs = Math.ceil(
    PRODUCTION_DISPATCH_TARGETS / EFFECTIVE_SEND_MESSAGES_PER_SECOND,
  ) * 1_000;
  const estimatedInvocationWallMs =
    PRODUCTION_SOURCE_PRESET_WALL_MS +
    fanoutInputLoadCallCount * PRODUCTION_FANOUT_INPUT_PAGE_WALL_MS +
    planningPageCount * PRODUCTION_PLANNING_PAGE_WALL_MS +
    handoffOperationCount * PRODUCTION_HANDOFF_OPERATION_WALL_MS +
    pendingDrainWallMs;
  return {
    subscriberCount: PRODUCTION_DISPATCH_SUBSCRIBERS,
    candidateSubscriberCount: PRODUCTION_DISPATCH_CANDIDATE_SUBSCRIBERS,
    targetCount: PRODUCTION_DISPATCH_TARGETS,
    sourceEventCount: 1,
    capturePageCount,
    planningPageCount,
    fanoutInputLoadCallCount,
    duplicatedFanoutInputLoadCallCount: Math.max(0, fanoutInputLoadCallCount - capturePageCount),
    handoffPageCount,
    handoffOperationCount,
    maxHandoffOperationsPerPage: PRODUCTION_HANDOFF_OPERATIONS_PER_PAGE,
    coordinatorStepCount,
    estimatedInvocationWallMs,
    maxInvocationWallMs: PRODUCTION_DISPATCH_WALL_BUDGET_MS,
  };
}

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

export const DISPATCH_CPU_MS = readDispatchCpuMs();
export const CPU_BUDGET_CEILING_MS = DISPATCH_CPU_MS * CPU_BUDGET_SAFETY_FRACTION;

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

export const EFFECTIVE_SEND_MESSAGES_PER_SECOND = Math.min(
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
  // Mirrors the production "usd-top50" preset id (worker/src/lib/telegram/presets.ts);
  // the fixture pool only has 25 hot ids, so this currently resolves to the same set as usd-top25.
  "usd-top50": HOT_COIN_IDS.slice(0, 25),
  "eur-top10": ["eurt-tether", "eurc-circle", "eurs-stasis"],
  "gold-top5": ["paxg-paxos", "xaut-tether"],
  "mcap-ge-1b": HOT_COIN_IDS.slice(0, 12),
  "mcap-ge-100m": HOT_COIN_IDS.slice(0, 20),
} as const;

const PRESET_IDS = Object.keys(PRESET_MEMBERS) as Array<keyof typeof PRESET_MEMBERS>;

function hasAlertFlag(flags: AlertFlags | Omit<AlertFlags, "launch" | "reserve" | "freeze">, alertType: AlertType): boolean {
  if (alertType === "launch" || alertType === "reserve" || alertType === "freeze") return false;
  return flags[alertType] === true;
}

function mergeFlags(left: AlertFlags, right: AlertFlags): AlertFlags {
  return {
    depeg: left.depeg || right.depeg,
    dews: left.dews || right.dews,
    safety: left.safety || right.safety,
    launch: left.launch || right.launch,
    reserve: left.reserve || right.reserve,
    freeze: left.freeze || right.freeze,
  };
}

function buildDirectFlags(i: number, j: number): AlertFlags {
  return {
    depeg: (i + j) % 10 !== 0,
    dews: (i + 2 * j) % 3 === 0,
    safety: (i + j) % 4 === 0,
    launch: (i + j) % 19 === 0,
    reserve: (i + j) % 23 === 0,
    freeze: (i + j) % 17 === 0,
  };
}

function buildGlobalFlags(i: number): AlertFlags {
  return {
    depeg: i % 2 === 0 || i % 13 === 0,
    dews: i % 29 === 0,
    safety: i % 14 === 0,
    launch: i % 101 === 0,
    reserve: i % 67 === 0,
    freeze: i % 31 === 0,
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
    watcher.globals.freeze ||
    watcher.directSubscriptions.some(
      (sub) => sub.flags.depeg || sub.flags.dews || sub.flags.safety || sub.flags.launch || sub.flags.reserve || sub.flags.freeze,
    ) ||
    watcher.presetSubscriptions.some((preset) => preset.flags.depeg || preset.flags.dews || preset.flags.safety)
  );
}

export function summarizeFixture(fixture: SyntheticTelegramFixture): SyntheticFixtureSummary {
  const globalOptIns: Record<AlertType, number> = { depeg: 0, dews: 0, safety: 0, launch: 0, reserve: 0, freeze: 0 };
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
    (sub) => sub.stablecoinId === event.stablecoinId && !sub.snoozed && sub.flags[event.alertType],
  );
}

function hasPresetMatch(watcher: SyntheticWatcher, event: EventSpec): boolean {
  if (event.alertType === "launch" || event.alertType === "reserve" || event.alertType === "freeze") return false;
  return watcher.presetSubscriptions.some((preset) => {
    const presetMembers: readonly string[] = PRESET_MEMBERS[preset.presetId];
    return hasAlertFlag(preset.flags, event.alertType) && presetMembers.includes(event.stablecoinId);
  });
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
    : postRecoverySeconds <= SPIKE_MAX_SECONDS
      ? "slow"
      : "breach";
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
        .filter(
          (key): key is AlertType =>
            key === "depeg" || key === "dews" || key === "safety" || key === "launch" || key === "reserve" || key === "freeze",
        ),
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
  const freezeEvents: EventSpec[] = [{ alertType: "freeze", stablecoinId: "usdc-circle" }];

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
      scenarioId: "freeze-event",
      scenarioLabel: "Single immutable USDC freeze event",
      hitsByChat: collectEventHits(fixture, freezeEvents),
      // Dedicated source capture plus target-page reads; no generic plan table.
      fanoutReadQueries: 4,
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
