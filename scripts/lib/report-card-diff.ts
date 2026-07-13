import { ReportCardsResponseSchema, type ReportCard, type ReportCardsResponse } from "@shared/types/report-cards";
import { isRecord } from "@shared/lib/type-guards";

const DIMENSION_KEYS = ["pegStability", "liquidity", "resilience", "decentralization", "dependencyRisk"] as const;

type DimensionKey = (typeof DIMENSION_KEYS)[number];

export interface ValueChange<T = unknown> {
  before: T;
  after: T;
}

export interface ReportCardAssetDiff {
  id: string;
  changeKind: "added" | "removed" | "changed";
  scoreChange: ValueChange<number | null> | null;
  gradeChange: ValueChange<string> | null;
  dimensionChanges: Partial<Record<DimensionKey, ValueChange<{ score: number | null; grade: string }>>>;
  rawInputChanges: Record<string, ValueChange>;
  bindingSignalChanges: Record<string, ValueChange>;
  classification: "input" | "methodology" | "mixed" | "asset-set";
  absoluteScoreChange: number | null;
}

export interface ReportCardDiffReport {
  generatedAt: string;
  before: {
    methodologyVersion: string;
    updatedAt: number;
    cardCount: number;
  };
  after: {
    methodologyVersion: string;
    updatedAt: number;
    cardCount: number;
  };
  methodologyChanged: boolean;
  freshnessChanges: Record<string, ValueChange>;
  summary: {
    addedAssets: number;
    removedAssets: number;
    changedAssets: number;
    scoreChanges: number;
    gradeChanges: number;
    nrEntries: number;
    nrExits: number;
    inputOnlyChanges: number;
    methodologyOnlyChanges: number;
    mixedChanges: number;
    graphEdgesAdded: number;
    graphEdgesRemoved: number;
  };
  assetChanges: ReportCardAssetDiff[];
  graphChanges: {
    added: string[];
    removed: string[];
  };
}

export interface CompareReportCardPayloadsOptions {
  generatedAt: string;
  allowMethodologyMismatch?: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parsePayload(value: unknown, label: string): ReportCardsResponse {
  const candidate = isRecord(value) && isRecord(value.payload) ? value.payload : value;
  const parsed = ReportCardsResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label} report-card payload is malformed at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }

  const seen = new Set<string>();
  for (const card of parsed.data.cards) {
    if (seen.has(card.id)) throw new Error(`${label} report-card payload contains duplicate ID: ${card.id}`);
    seen.add(card.id);
  }
  return parsed.data;
}

function collectChanges(before: unknown, after: unknown): Record<string, ValueChange> {
  const left = isRecord(before) ? before : {};
  const right = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return Object.fromEntries(
    keys.flatMap((key) =>
      stableStringify(left[key]) === stableStringify(right[key])
        ? []
        : [[key, { before: stableValue(left[key]), after: stableValue(right[key]) }]],
    ),
  );
}

function dependencyKey(dependency: ReportCard["rawInputs"]["dependencies"][number]): string {
  return `${dependency.id}:${dependency.type ?? "collateral"}:${dependency.weight}`;
}

function bindingSignals(card: ReportCard): Record<string, unknown> {
  const dependencyCeiling =
    card.dimensions.dependencyRisk.detailItems?.find((item) => item.label === "Ceiling")?.value ?? null;
  return {
    activeDepeg: card.rawInputs.activeDepeg,
    activeDepegBps: card.rawInputs.activeDepegBps ?? null,
    dependencyCeiling,
    dependencyFromLive: card.rawInputs.dependencyFromLive ?? false,
    mechanismDependencies: card.rawInputs.dependencies
      .filter((dependency) => dependency.type === "mechanism")
      .map(dependencyKey)
      .sort(),
    variantKind: card.rawInputs.variantKind ?? null,
    variantParentId: card.rawInputs.variantParentId ?? null,
    wrapperDependencies: card.rawInputs.dependencies
      .filter((dependency) => dependency.type === "wrapper")
      .map(dependencyKey)
      .sort(),
  };
}

function edgeKey(edge: ReportCardsResponse["dependencyGraph"]["edges"][number]): string {
  return `${edge.from}->${edge.to}:${edge.type}:${edge.weight}`;
}

function optionalChange<T>(before: T, after: T): ValueChange<T> | null {
  return stableStringify(before) === stableStringify(after) ? null : { before, after };
}

function diffExistingCard(
  before: ReportCard,
  after: ReportCard,
  methodologyChanged: boolean,
): ReportCardAssetDiff | null {
  const scoreChange = optionalChange(before.overallScore, after.overallScore);
  const gradeChange = optionalChange(before.overallGrade, after.overallGrade);
  const dimensionChanges = Object.fromEntries(
    DIMENSION_KEYS.flatMap((key) => {
      const left = { score: before.dimensions[key].score, grade: before.dimensions[key].grade };
      const right = { score: after.dimensions[key].score, grade: after.dimensions[key].grade };
      return stableStringify(left) === stableStringify(right) ? [] : [[key, { before: left, after: right }]];
    }),
  ) as ReportCardAssetDiff["dimensionChanges"];
  const rawInputChanges = collectChanges(before.rawInputs, after.rawInputs);
  const bindingSignalChanges = collectChanges(bindingSignals(before), bindingSignals(after));
  const changed =
    scoreChange != null ||
    gradeChange != null ||
    Object.keys(dimensionChanges).length > 0 ||
    Object.keys(rawInputChanges).length > 0 ||
    Object.keys(bindingSignalChanges).length > 0;
  if (!changed) return null;

  // Binding signals include derived outputs such as the ceiling that won after
  // scoring. Report them for review, but do not misclassify them as source
  // input changes when the raw inputs are byte-identical.
  const inputsChanged = Object.keys(rawInputChanges).length > 0;
  const classification = inputsChanged ? (methodologyChanged ? "mixed" : "input") : "methodology";
  const absoluteScoreChange =
    before.overallScore == null || after.overallScore == null
      ? null
      : Math.abs(after.overallScore - before.overallScore);

  return {
    id: before.id,
    changeKind: "changed",
    scoreChange,
    gradeChange,
    dimensionChanges,
    rawInputChanges,
    bindingSignalChanges,
    classification,
    absoluteScoreChange,
  };
}

function assetSetDiff(card: ReportCard, changeKind: "added" | "removed"): ReportCardAssetDiff {
  return {
    id: card.id,
    changeKind,
    scoreChange: null,
    gradeChange: null,
    dimensionChanges: {},
    rawInputChanges: {},
    bindingSignalChanges: {},
    classification: "asset-set",
    absoluteScoreChange: null,
  };
}

function assertGeneratedAt(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error("generatedAt must be a valid ISO timestamp");
  }
}

export function compareReportCardPayloads(
  beforeValue: unknown,
  afterValue: unknown,
  options: CompareReportCardPayloadsOptions,
): ReportCardDiffReport {
  assertGeneratedAt(options.generatedAt);
  const before = parsePayload(beforeValue, "Before");
  const after = parsePayload(afterValue, "After");
  const methodologyChanged = before.methodology.version !== after.methodology.version;
  if (methodologyChanged && !options.allowMethodologyMismatch) {
    throw new Error(
      `Methodology mismatch: ${before.methodology.version} -> ${after.methodology.version}; pass allowMethodologyMismatch to compare intentionally`,
    );
  }

  const beforeById = new Map(before.cards.map((card) => [card.id, card]));
  const afterById = new Map(after.cards.map((card) => [card.id, card]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const assetChanges = ids.flatMap((id) => {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (!left && right) return [assetSetDiff(right, "added")];
    if (left && !right) return [assetSetDiff(left, "removed")];
    const diff = diffExistingCard(left!, right!, methodologyChanged);
    return diff ? [diff] : [];
  });
  assetChanges.sort(
    (left, right) =>
      (right.absoluteScoreChange ?? -1) - (left.absoluteScoreChange ?? -1) || left.id.localeCompare(right.id),
  );

  const beforeEdges = new Set(before.dependencyGraph.edges.map(edgeKey));
  const afterEdges = new Set(after.dependencyGraph.edges.map(edgeKey));
  const graphChanges = {
    added: [...afterEdges].filter((edge) => !beforeEdges.has(edge)).sort(),
    removed: [...beforeEdges].filter((edge) => !afterEdges.has(edge)).sort(),
  };
  const freshnessChanges = collectChanges(
    {
      inputFreshness: before.inputFreshness,
      liquidityStale: before.liquidityStale,
      redemptionStale: before.redemptionStale,
      updatedAt: before.updatedAt,
    },
    {
      inputFreshness: after.inputFreshness,
      liquidityStale: after.liquidityStale,
      redemptionStale: after.redemptionStale,
      updatedAt: after.updatedAt,
    },
  );

  return {
    generatedAt: new Date(options.generatedAt).toISOString(),
    before: {
      methodologyVersion: before.methodology.version,
      updatedAt: before.updatedAt,
      cardCount: before.cards.length,
    },
    after: {
      methodologyVersion: after.methodology.version,
      updatedAt: after.updatedAt,
      cardCount: after.cards.length,
    },
    methodologyChanged,
    freshnessChanges,
    summary: {
      addedAssets: assetChanges.filter((change) => change.changeKind === "added").length,
      removedAssets: assetChanges.filter((change) => change.changeKind === "removed").length,
      changedAssets: assetChanges.filter((change) => change.changeKind === "changed").length,
      scoreChanges: assetChanges.filter((change) => change.scoreChange != null).length,
      gradeChanges: assetChanges.filter((change) => change.gradeChange != null).length,
      nrEntries: assetChanges.filter(
        (change) => change.gradeChange?.after === "NR" && change.gradeChange.before !== "NR",
      ).length,
      nrExits: assetChanges.filter((change) => change.gradeChange?.before === "NR" && change.gradeChange.after !== "NR")
        .length,
      inputOnlyChanges: assetChanges.filter((change) => change.classification === "input").length,
      methodologyOnlyChanges: assetChanges.filter((change) => change.classification === "methodology").length,
      mixedChanges: assetChanges.filter((change) => change.classification === "mixed").length,
      graphEdgesAdded: graphChanges.added.length,
      graphEdgesRemoved: graphChanges.removed.length,
    },
    assetChanges,
    graphChanges,
  };
}

export function serializeReportCardDiff(report: ReportCardDiffReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReportCardDiffMarkdown(report: ReportCardDiffReport): string {
  const lines = [
    "# Safety Score Tranche Delta",
    "",
    `Generated: ${report.generatedAt}`,
    `Methodology: v${report.before.methodologyVersion} -> v${report.after.methodologyVersion}`,
    "",
    "## Summary",
    "",
    `- Assets added/removed/changed: ${report.summary.addedAssets}/${report.summary.removedAssets}/${report.summary.changedAssets}`,
    `- Score changes / grade crossings: ${report.summary.scoreChanges}/${report.summary.gradeChanges}`,
    `- NR entries / exits: ${report.summary.nrEntries}/${report.summary.nrExits}`,
    `- Graph edges added / removed: ${report.summary.graphEdgesAdded}/${report.summary.graphEdgesRemoved}`,
    "",
    "## Largest Changes",
    "",
    "| Asset | Kind | Score | Grade | Cause |",
    "| --- | --- | --- | --- | --- |",
    ...report.assetChanges.map((change) => {
      const score = change.scoreChange
        ? `${change.scoreChange.before ?? "NR"} -> ${change.scoreChange.after ?? "NR"}`
        : "-";
      const grade = change.gradeChange ? `${change.gradeChange.before} -> ${change.gradeChange.after}` : "-";
      return `| ${change.id} | ${change.changeKind} | ${score} | ${grade} | ${change.classification} |`;
    }),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
