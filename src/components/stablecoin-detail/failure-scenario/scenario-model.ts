import type {
  FailureScenario,
  FailureScenarioBranch,
  FailureScenarioDefenderVerdict,
  FailureScenarioEvidence,
  FailureScenarioFalsifierStatus,
  FailureScenarioSource,
  FailureScenarioStage,
} from "@shared/types/failure-scenarios";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { resolveChainId } from "@shared/types/chain-identity";

/** What the route passes down: one publishable (or dev-preview draft) record. */
export interface FailureScenarioSelection {
  scenario: FailureScenario;
  /** True only in a development preview of a record that is not approved. */
  isDraft: boolean;
}

export const EVIDENCE_LABEL: Record<FailureScenarioEvidence, string> = {
  "verified-onchain": "Verified onchain",
  documented: "Documented",
  inferred: "Inferred",
  unverified: "Unverified",
};

/** Legend order: strongest support first. */
export const EVIDENCE_ORDER: readonly FailureScenarioEvidence[] = ["verified-onchain", "documented", "inferred", "unverified"];

export const DEFENDER_VERDICT_LABEL: Record<FailureScenarioDefenderVerdict, string> = {
  "cannot-stop": "Cannot stop it",
  partial: "Partial",
  "can-stop": "Can stop it",
  unverified: "Unverified",
};

export const FALSIFIER_STATUS_LABEL: Record<FailureScenarioFalsifierStatus, string> = {
  "not-met": "Not met",
  met: "Met: scenario suspended",
  unverified: "Not yet checked",
};

/**
 * A step is drawn as a hypothetical hop (dashed node and incoming line) when
 * it is a premise or its support stops at inference.
 */
export function isHypotheticalStage(stage: FailureScenarioStage): boolean {
  return stage.kind === "premise" || stage.evidence === "inferred" || stage.evidence === "unverified";
}

/** One step placed on the path. */
export interface RouteStep {
  stage: FailureScenarioStage;
  /**
   * 1-based position on the path. Alternative routes are not sequential, so
   * their first steps share the position immediately after the trunk prefix.
   */
  number: number;
  /** The branch the step belongs to, or null on the shared trunk. */
  laneId: string | null;
}

export interface RouteLane {
  branch: FailureScenarioBranch;
  steps: RouteStep[];
}

/**
 * The scenario as drawn: the trunk up to the branch point (`pre`), the
 * alternative routes side by side (`lanes`, empty without a branch point),
 * then the trunk they all rejoin (`post`).
 */
export interface ScenarioRoute {
  pre: RouteStep[];
  lanes: RouteLane[];
  post: RouteStep[];
  /** Steps on the longest way through, i.e. the last step's number. */
  length: number;
  /** Every step in reading order: trunk prefix, each route in authored order, trunk suffix. */
  steps: RouteStep[];
  /** The path's outcome: the last trunk step. */
  terminalStageId: string;
}

export function buildScenarioRoute(scenario: FailureScenario): ScenarioRoute {
  const forkIndex = scenario.branchPoint
    ? scenario.stages.findIndex((stage) => stage.id === scenario.branchPoint?.afterStageId)
    : -1;
  const hasLanes = scenario.branchPoint !== undefined && forkIndex >= 0 && forkIndex < scenario.stages.length - 1;
  const preStages = hasLanes ? scenario.stages.slice(0, forkIndex + 1) : scenario.stages;
  const postStages = hasLanes ? scenario.stages.slice(forkIndex + 1) : [];

  const pre = preStages.map((stage, index) => ({ stage, number: index + 1, laneId: null }));
  const lanes: RouteLane[] = hasLanes
    ? (scenario.branchPoint?.branches ?? []).map((branch) => ({
        branch,
        steps: branch.stages.map((stage, index) => ({ stage, number: pre.length + index + 1, laneId: branch.id })),
      }))
    : [];
  const laneLength = Math.max(0, ...lanes.map((lane) => lane.steps.length));
  const post = postStages.map((stage, index) => ({
    stage,
    number: pre.length + laneLength + index + 1,
    laneId: null,
  }));
  const steps = [...pre, ...lanes.flatMap((lane) => lane.steps), ...post];
  const trunkTail = post.at(-1) ?? pre.at(-1);
  return {
    pre,
    lanes,
    post,
    length: pre.length + laneLength + post.length,
    steps,
    terminalStageId: trunkTail?.stage.id ?? "",
  };
}

const CLOCK_SUFFIX = " (or earlier)";
const UNIT_HOURS: Record<string, number> = { m: 1 / 60, min: 1 / 60, h: 1, d: 24, w: 168 };

/**
 * One `T+<amount><unit>` instant in hours, or null when the label is not on
 * the clock convention. Hand-rolled rather than a regex: the optional
 * unit/suffix combination trips `security/detect-unsafe-regex`.
 */
function parseClockPoint(point: string): number | null {
  if (!point.startsWith("T+")) return null;
  let body = point.slice(2);
  if (body.endsWith(CLOCK_SUFFIX)) body = body.slice(0, -CLOCK_SUFFIX.length);
  let digits = 0;
  while (digits < body.length && (body[digits] >= "0" && body[digits] <= "9")) digits += 1;
  if (digits === 0) return null;
  let cursor = digits;
  if (body[cursor] === ".") {
    cursor += 1;
    const fraction = cursor;
    while (cursor < body.length && body[cursor] >= "0" && body[cursor] <= "9") cursor += 1;
    if (cursor === fraction) return null;
  }
  const amount = Number(body.slice(0, cursor));
  const unit = body.slice(cursor).trim().toLowerCase();
  if (!unit) return amount === 0 ? 0 : null;
  const scale = UNIT_HOURS[unit];
  if (scale === undefined) return null;
  const value = amount * scale;
  return Number.isFinite(value) ? value : null;
}

/**
 * Optional clock convention, not a requirement for a stage label. Parse only
 * complete T+ instants or forward ranges: never infer units or extract a
 * plausible instant from prose. Unitless zero and "(or earlier)" are allowed.
 */
export function parseElapsed(elapsed: string): { start: number; end: number } | null {
  const points = elapsed.split("→");
  if (points.length > 2) return null;
  const hours: number[] = [];
  for (const point of points) {
    const value = parseClockPoint(point.trim().replace(/\s+/g, " "));
    if (value === null) return null;
    hours.push(value);
  }
  const start = hours[0];
  const end = hours.at(-1)!;
  return end >= start ? { start, end } : null;
}

/** "2–4", "2, 4", "6": the step numbers a marker stands for. */
export function formatStepNumbers(numbers: readonly number[]): string {
  if (numbers.length === 1) return String(numbers[0]);
  const contiguous = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
  return contiguous ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join(", ");
}

/** Steps of one row that happen at the same instant, drawn as one flag. */
export interface ClockFlag {
  at: number;
  numbers: number[];
  /** Every step in the flag is hypothetical (dashed). */
  hypothetical: boolean;
  /** The flag holds the path's outcome step. */
  terminal: boolean;
}

/** A step that takes time, drawn as a span with its number at the midpoint. */
export interface ClockSpan {
  start: number;
  end: number;
  number: number;
  hypothetical: boolean;
  terminal: boolean;
}

/** One swimlane: the shared trunk, or one alternative route. */
export interface ClockRow {
  id: string;
  /** Route label, or null for the trunk. */
  label: string | null;
  /** Route key label ("3 of 5"), or null for the trunk. */
  keys: string | null;
  flags: ClockFlag[];
  spans: ClockSpan[];
}

export interface ClockTick {
  hours: number;
  label: string;
}

export interface ScenarioClockModel {
  horizonHours: number;
  ticks: ClockTick[];
  rows: ClockRow[];
  window: { start: number; end: number } | null;
}

/** "T+7d", "T+36h", "T+45m". */
export function formatClockPoint(hours: number): string {
  if (hours === 0) return "T+0";
  if (hours >= 24 && Number.isInteger(hours / 24)) return `T+${hours / 24}d`;
  if (hours >= 1) return `T+${Number(hours.toFixed(1))}h`;
  return `T+${Math.round(hours * 60)}m`;
}

/** Tick spacings, in hours, from a quarter hour to a month. */
const TICK_STEPS_HOURS = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 168, 336, 720];
const MAX_TICK_INTERVALS = 8;

function buildTicks(horizonHours: number): ClockTick[] {
  const step = TICK_STEPS_HOURS.find((candidate) => horizonHours / candidate <= MAX_TICK_INTERVALS)
    ?? horizonHours / MAX_TICK_INTERVALS;
  const ticks: ClockTick[] = [];
  for (let hours = 0; hours < horizonHours - step / 2; hours += step) {
    ticks.push({ hours, label: hours === 0 ? "T+0" : formatClockPoint(hours).replace("T+", "") });
  }
  ticks.push({ hours: horizonHours, label: formatClockPoint(horizonHours) });
  return ticks;
}

function buildClockRow(
  id: string,
  label: string | null,
  keys: string | null,
  steps: readonly RouteStep[],
  terminalStageId: string,
): ClockRow {
  const byInstant = new Map<number, RouteStep[]>();
  const spans: ClockSpan[] = [];
  for (const step of steps) {
    const position = parseElapsed(step.stage.elapsed);
    if (!position) continue;
    if (position.start === position.end) {
      byInstant.set(position.start, [...(byInstant.get(position.start) ?? []), step]);
    } else {
      spans.push({
        ...position,
        number: step.number,
        hypothetical: isHypotheticalStage(step.stage),
        terminal: step.stage.id === terminalStageId,
      });
    }
  }
  const flags = [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, group]) => ({
      at,
      numbers: group.map((step) => step.number),
      hypothetical: group.every((step) => isHypotheticalStage(step.stage)),
      terminal: group.some((step) => step.stage.id === terminalStageId),
    }));
  return { id, label, keys, flags, spans };
}

/**
 * Optional to-scale swimlanes. Every stage must have an explicit clock
 * position and the scenario must span more than one instant; otherwise omit
 * the whole ruler rather than silently dropping stages or inventing time.
 * Authored path order need not be chronological. An optional window is drawn
 * only when its endpoints describe a forward interval.
 */
export function buildScenarioClock(scenario: FailureScenario, route: ScenarioRoute): ScenarioClockModel | null {
  const positions = route.steps.map((step) => parseElapsed(step.stage.elapsed));
  if (positions.length === 0 || !positions.every((position): position is { start: number; end: number } => position !== null)) {
    return null;
  }
  const horizonHours = Math.max(...positions.map((position) => position.end));
  const firstHours = Math.min(...positions.map((position) => position.start));
  if (horizonHours <= firstHours) return null;

  const rows: ClockRow[] = [
    buildClockRow("trunk", null, null, [...route.pre, ...route.post], route.terminalStageId),
    ...route.lanes.map((lane) =>
      buildClockRow(lane.branch.id, lane.branch.label, lane.branch.keys, lane.steps, route.terminalStageId),
    ),
  ].filter((row) => row.flags.length > 0 || row.spans.length > 0);

  let window: ScenarioClockModel["window"] = null;
  if (scenario.window) {
    const byId = new Map(route.steps.map((step) => [step.stage.id, parseElapsed(step.stage.elapsed)]));
    const from = byId.get(scenario.window.fromStageId);
    const to = byId.get(scenario.window.toStageId);
    if (from && to && to.end > from.start) window = { start: from.start, end: to.end };
  }
  return { horizonHours, ticks: buildTicks(horizonHours), rows, window };
}

/** Plain-language summary of the clock for its `role="img"` label. */
export function describeScenarioClock(clock: ScenarioClockModel, scenario: FailureScenario, sharedLabel: string): string {
  const rows = clock.rows.map((row) => {
    const events = [
      ...row.flags.map((flag) => ({
        at: flag.at,
        text: `${flag.numbers.length === 1 ? "step" : "steps"} ${formatStepNumbers(flag.numbers)} at ${formatClockPoint(flag.at)}`,
      })),
      ...row.spans.map((span) => ({
        at: span.start,
        text: `step ${span.number} runs ${formatClockPoint(span.start)} to ${formatClockPoint(span.end)}`,
      })),
    ].sort((a, b) => a.at - b.at);
    const name = row.label ? `${row.label} (${row.keys})` : sharedLabel;
    return `${name}: ${events.map((event) => event.text).join(", ")}`;
  });
  const windowPart = clock.window && scenario.window ? ` ${scenario.window.label}: ${scenario.window.duration}.` : "";
  return `Scenario clock, to scale, T+0 to ${formatClockPoint(clock.horizonHours)}. ${rows.join(". ")}.${windowPart}`;
}

/** Anchor of one step's disclosure in the step-by-step list. */
export function stepAnchorId(prefix: string, stageId: string): string {
  return `${prefix}-${stageId}`;
}

export interface NumberedSource extends FailureScenarioSource {
  /** 1-based position in the scenario's source list, as cited inline. */
  number: number;
}

export function numberSources(sources: readonly FailureScenarioSource[]): Map<string, NumberedSource> {
  return new Map(sources.map((source, index) => [source.id, { ...source, number: index + 1 }]));
}

/** Cited sources in the order the scenario lists them, dropping unknown ids. */
export function resolveCitations(
  sourceIds: readonly string[],
  numbered: ReadonlyMap<string, NumberedSource>,
): NumberedSource[] {
  return sourceIds
    .map((id) => numbered.get(id))
    .filter((source): source is NumberedSource => source !== undefined)
    .sort((a, b) => a.number - b.number);
}

export function buildTargetExplorerUrl(address: string, chainId: number): string | null {
  const chainKey = resolveChainId(chainId);
  return chainKey ? buildExplorerUrl({ chainKey, entityType: "address", value: address }) : null;
}

const BLOCK_FORMAT = new Intl.NumberFormat("en-US");

export function formatBlock(block: number): string {
  return BLOCK_FORMAT.format(block);
}
