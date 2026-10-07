import type { SafetyScoreV9IssuanceSummary } from "@shared/types/safety-score-v9-public-breakdowns";
import type { MintAuthorityProcessDiagnosticViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";

type ProcessReasonCode = SafetyScoreV9IssuanceSummary["diagnostics"][number]["code"];

/**
 * Reader labels for the published issuance-process reason codes. The raw
 * codes, gate ids ("D32", "H0"), class ids, path ids and evidence ids are
 * evaluator identifiers and never reach the page; the facts they carry
 * (how many findings, on how many controls, citing how many references) do.
 */
const PROCESS_REASON_LABELS = {
  "process-certificate-unavailable": "Process certificate unavailable",
  "authority-census-incomplete": "Authority census incomplete",
  "execution-scope-unreviewed": "Execution scope not reviewed",
  "runtime-unmatched": "Runtime not matched to reviewed code",
  "implementation-unmatched": "Implementation not matched to reviewed code",
  "instance-state-unmatched": "Instance state not matched to the review",
  "authority-state-changed": "Authority state changed since review",
  "authority-state-mismatch": "Authority state differs from the review",
  "execution-class-unmatched": "Execution class not matched",
  "economic-reach-unclosed": "Economic reach not fully traced",
  "graph-reference-unresolved": "Authority graph reference unresolved",
  "graph-cycle-unclosed": "Authority graph cycle not closed",
  "governor-control-missing": "Governor control missing",
  "governor-not-governance": "Governor is not token governance",
  "governor-without-issuance-path": "Governor has no issuance path",
  "governor-without-veto-path": "Governor has no veto path",
  "governor-carries-unbounded-path": "Governor carries an unbounded path",
  "discretionary-root-independent": "Discretionary mint independent of governance",
  "delay-unproved": "Delay not proven",
  "delay-too-short": "Public delay too short",
  "voting-power-inadmissible": "Voting-power basis not admissible",
  "issuance-not-enumerable": "Issuance paths not enumerable",
  "operational-path-unclassified": "Operational path unclassified",
  "operational-cap-unproved": "Operational cap not proven",
  "operational-screen-failed": "Operational screen failed",
  "operational-decision-rule-inadmissible": "Operational decision rule not admissible",
  "formula-principal-unproved": "Formula principal not proven",
  "formula-time-unproved": "Formula timing not proven",
  "formula-beneficiary-unproved": "Formula beneficiary not proven",
  "rate-units-unproved": "Rate units not proven",
  "interest-aggregate-unproved": "Aggregate interest not proven",
  "keeper-activity-unproved": "Keeper activity not proven",
  "aggregate-flow-unproved": "Aggregate flow not proven",
  "voting-control-unproved": "Voting control not proven",
  "voting-affiliated-unilateral": "Affiliated voters can pass proposals alone",
  "shared-book-unresolved": "Shared evidence book unresolved",
  "shared-book-mismatch": "Shared evidence book mismatch",
  "shared-book-stale": "Shared evidence book stale",
  "voting-privilege-independent": "Vote privileges independent of governance",
  "voting-census-unreconciled": "Voting census not reconciled",
  "voting-provenance-unknown": "Vote ownership unknown",
  "voting-other-holder-operator": "A key votes other holders' tokens",
  "voting-origin-cycle-unclosed": "Vote origin cycle not closed",
  "review-incomplete": "Review incomplete",
  "review-future": "Review dated in the future",
  "review-expired": "Review expired",
  "scoped-question-open": "Scoped review question open",
  "active-incident": "Active incident",
  "monetary-policy-path-unreviewed": "Monetary-policy path not reviewed",
  "monetary-policy-path-inadmissible": "Monetary-policy path not admissible",
  "restructure-path-missing": "Restructure path missing",
  "restructure-reachable": "Restructure reachable",
  "restructure-dependent-path-invalid": "Restructure-dependent path invalid",
  "external-accounting-trust": "Relies on external accounting",
} as const satisfies Record<ProcessReasonCode, string>;

function sentenceCase(words: readonly string[]): string {
  const text = words.join(" ");
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

/**
 * Plain label for a process reason. The live report card can carry a reason
 * code newer than this client's label map, so an unmapped code reads as its
 * own words rather than as a slug.
 */
export function processReasonLabel(code: string): string {
  return Object.hasOwn(PROCESS_REASON_LABELS, code)
    ? PROCESS_REASON_LABELS[code as ProcessReasonCode]
    : sentenceCase(code.split(/[-_]+/).filter(Boolean));
}

/** Path containers whose next segment is an evaluator id (`routes.<id>.…`). */
const FIELD_COLLECTIONS: Record<string, string> = {
  routes: "route",
  nodes: "node",
  edges: "edge",
  censuses: "census",
  controllers: "controller",
  classes: "class",
  paths: "path",
};

/** Keys whose split words read poorly; everything else is split from camelCase. */
const FIELD_KEY_LABELS: Record<string, string> = {
  authorityGraph: "authority graph",
  controllerPowers: "controller voting power",
  residualUpperRaw: "residual voting power",
  affiliatedAggregate: "affiliated voting power",
  affiliatedThreshold: "affiliated voting threshold",
  otherHoldersPowerRaw: "other holders' voting power",
  governorNodeId: "governor",
  issuanceProcess: "issuance process",
  issuanceGovernance: "issuance governance",
};

/** Unit and reference suffixes that add no meaning in prose. */
const DROPPED_FIELD_WORDS: Record<string, true> = {
  raw: true, ref: true, refs: true, id: true, ids: true, ppm: true, bps: true, sec: true,
};
const FIELD_WORD_EXPANSIONS: Record<string, string> = { min: "minimum", max: "maximum" };

const PLAIN_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

function humanizeFieldKey(key: string): string[] {
  const mapped = FIELD_KEY_LABELS[key];
  if (mapped) return [mapped];
  return key
    .replace(/([a-z])(?=[A-Z])|([a-zA-Z])(?=\d)|(\d)(?=[a-zA-Z])/g, "$& ")
    .split(" ")
    .map((word) => word.toLowerCase())
    .filter((word) => !Object.hasOwn(DROPPED_FIELD_WORDS, word))
    .map((word) => FIELD_WORD_EXPANSIONS[word] ?? word);
}

/**
 * Reader label for a published diagnostic field path. Evaluator ids inside the
 * path (route, node, edge, census and controller ids, which carry hyphens,
 * hashes or addresses) are dropped, so `routes.aave-l1-unopposed-3.controllerPowers`
 * and its siblings all read "Route controller voting power" and group together.
 * Null when nothing readable remains.
 */
export function humanizeDiagnosticField(field: string): string | null {
  const words: string[] = [];
  let previous: string | null = null;
  for (const segment of field.split(".")) {
    const afterCollection = previous !== null && Object.hasOwn(FIELD_COLLECTIONS, previous);
    const isIdentifier = !PLAIN_KEY_PATTERN.test(segment) || (afterCollection && !Object.hasOwn(FIELD_KEY_LABELS, segment));
    if (!isIdentifier) {
      words.push(...(Object.hasOwn(FIELD_COLLECTIONS, segment) ? [FIELD_COLLECTIONS[segment]!] : humanizeFieldKey(segment)));
    }
    previous = segment;
  }
  return words.length > 0 ? sentenceCase(words) : null;
}

export type MintIssuanceDiagnosticStatus = MintAuthorityProcessDiagnosticViewModel["statusLabel"];

/** Failures first, then missing proof, then analytical notes. */
const STATUS_ORDER: Record<MintIssuanceDiagnosticStatus, number> = {
  "Failed gate": 0,
  "Failed screen": 1,
  "Missing evidence": 2,
  "Analytical note": 3,
};

export interface MintIssuanceDiagnosticFieldRow {
  label: string;
  /** Findings on fields that share this label. */
  count: number;
}

/** One reader row: every published group with the same status and reason. */
export interface MintIssuanceDiagnosticGroup {
  key: string;
  status: MintIssuanceDiagnosticStatus;
  reasonLabel: string;
  /** Findings across the merged published groups. */
  count: number;
  /** Distinct controls the findings name. */
  controlCount: number;
  /** At least one finding is process-level rather than tied to one control. */
  processLevel: boolean;
  /** Names of rendered controls the findings touch, in control order. */
  controlLabels: string[];
  /** Distinct execution classes, counted rather than named. */
  classCount: number;
  /** Size of the evidence table the sampled findings cite (0 when none). */
  evidenceRefCount: number;
  /** Affected fields, identical labels merged with their finding counts. */
  fields: MintIssuanceDiagnosticFieldRow[];
}

export interface MintIssuanceDiagnosticsView {
  groups: MintIssuanceDiagnosticGroup[];
  /** Findings across every group. */
  total: number;
  /** Findings per status, in display order; zero-count statuses omitted. */
  statusCounts: { status: MintIssuanceDiagnosticStatus; count: number }[];
}

/**
 * Collapses the published diagnostic groups into one reader row per
 * status + reason. A coin like GHO publishes 36 groups that split one reason
 * across per-route or per-node field paths; they read as 7 rows here, each
 * with its finding count and the affected fields merged by label.
 *
 * `controls` maps findings to the control rows the module renders: a
 * diagnostic attached to a control's `processDiagnostics` names that control.
 */
export function groupMintIssuanceDiagnostics(
  diagnostics: readonly MintAuthorityProcessDiagnosticViewModel[],
  controls: readonly { label: string; processDiagnostics: readonly { key: string }[] }[] = [],
): MintIssuanceDiagnosticsView {
  const unique = [...new Map(diagnostics.map((diagnostic) => [diagnostic.key, diagnostic] as const)).values()];
  const rows = new Map<string, {
    status: MintIssuanceDiagnosticStatus;
    code: string;
    count: number;
    controlRefs: Set<string>;
    processLevel: boolean;
    diagnosticKeys: Set<string>;
    classIds: Set<string>;
    evidenceRefCount: number;
    fields: Map<string, number>;
  }>();

  for (const diagnostic of unique) {
    const key = `${diagnostic.statusLabel}\u0000${diagnostic.code}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        status: diagnostic.statusLabel,
        code: diagnostic.code,
        count: 0,
        controlRefs: new Set(),
        processLevel: false,
        diagnosticKeys: new Set(),
        classIds: new Set(),
        evidenceRefCount: 0,
        fields: new Map(),
      };
      rows.set(key, row);
    }
    row.count += diagnostic.count;
    row.diagnosticKeys.add(diagnostic.key);
    for (const ref of diagnostic.controlRefs) {
      if (ref === null) row.processLevel = true;
      else row.controlRefs.add(ref);
    }
    if (diagnostic.classId) row.classIds.add(diagnostic.classId);
    for (const exemplar of diagnostic.exemplars) {
      row.evidenceRefCount = Math.max(row.evidenceRefCount, exemplar.evidenceRefCount);
    }
    const fieldLabel = humanizeDiagnosticField(diagnostic.field);
    if (fieldLabel) row.fields.set(fieldLabel, (row.fields.get(fieldLabel) ?? 0) + diagnostic.count);
  }

  const groups = [...rows.entries()]
    .map(([key, row]): MintIssuanceDiagnosticGroup => ({
      key,
      status: row.status,
      reasonLabel: processReasonLabel(row.code),
      count: row.count,
      controlCount: row.controlRefs.size,
      processLevel: row.processLevel,
      controlLabels: [...new Set(controls
        .filter((control) => control.processDiagnostics.some((diagnostic) => row.diagnosticKeys.has(diagnostic.key)))
        .map((control) => control.label))],
      classCount: row.classIds.size,
      evidenceRefCount: row.evidenceRefCount,
      fields: [...row.fields.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    }))
    .sort((left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      right.count - left.count ||
      left.reasonLabel.localeCompare(right.reasonLabel));

  const statusTotals = new Map<MintIssuanceDiagnosticStatus, number>();
  for (const group of groups) statusTotals.set(group.status, (statusTotals.get(group.status) ?? 0) + group.count);

  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.count, 0),
    statusCounts: [...statusTotals.entries()]
      .sort(([left], [right]) => STATUS_ORDER[left] - STATUS_ORDER[right])
      .map(([status, count]) => ({ status, count })),
  };
}
