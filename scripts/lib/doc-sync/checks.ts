import {
  Failure,
  findLineValue,
  read,
} from "./shared";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";
import {
  ISOLATE_LOCAL_STATE_DOC_END,
  ISOLATE_LOCAL_STATE_DOC_START,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";
import { findDocContractDrift } from "./contract-blocks";
import { END_MARKER, renderLaneFreshnessMatrix, START_MARKER } from "../../maintenance/generate-lane-freshness-matrix";

function checkGeneratedDocContractBlocks(failures: Failure[], readDocument: typeof read): void {
  for (const drift of findDocContractDrift(readDocument)) {
    failures.push({
      file: drift.file,
      label: `generated doc contract ${drift.id}`,
      expected: drift.expected,
      found: drift.found,
    });
  }
}

function checkWorkerInfrastructureIsolateStateDoc(failures: Failure[], readDocument: typeof read): void {
  for (const drift of findDocContractDrift(readDocument, [{
    file: "docs/process/worker-infrastructure-appendix.md",
    id: "isolate-local state registry",
    startMarker: ISOLATE_LOCAL_STATE_DOC_START,
    endMarker: ISOLATE_LOCAL_STATE_DOC_END,
    expected: renderIsolateLocalStateDocumentation(),
  }])) {
    failures.push({ file: drift.file, label: drift.id, expected: drift.expected, found: drift.found });
  }
}

function checkRedemptionBackstopsDoc(failures: Failure[], readDocument: typeof read): void {
  const file = "docs/redemption-backstops.md";
  const doc = readDocument(file);

  const sourceOwnedLine = findLineValue(doc, /- \*\*Configured coins and family counts:\*\* ([^\n]+)/) ?? "";
  if (!sourceOwnedLine.includes("`REDEMPTION_BACKSTOP_CONFIGS`")) {
    failures.push({
      file,
      label: "configured inventory owner",
      expected: "REDEMPTION_BACKSTOP_CONFIGS",
      found: sourceOwnedLine || null,
    });
  }
  const familyLine = findLineValue(doc, /- \*\*Route families:\*\* ([^\n]+)/) ?? "";
  const familyNames = new Set(Object.values(REDEMPTION_BACKSTOP_CONFIGS).map((config) => config.routeFamily));
  const seenInDoc = new Set(Array.from(familyLine.matchAll(/`([a-z-]+)`/g), (match) => match[1]));
  for (const family of familyNames) {
    if (!seenInDoc.has(family)) {
      failures.push({
        file,
        label: `${family} family listed in doc`,
        expected: "present",
        found: "missing",
      });
    }
  }
  if (/\d+\s+`[a-z-]+`/.test(familyLine)) {
    failures.push({
      file,
      label: "volatile redemption family counts",
      expected: "source-owned; no copied numeric counts",
      found: familyLine,
    });
  }
}

const LANE_FRESHNESS_FILE = "docs/process/lane-freshness-matrix.md";

/** Owner-review boundaries remain authored outside the generated matrix. */
function checkLaneFreshnessSignOff(failures: Failure[], readDocument: typeof read): void {
  const matrix = readDocument(LANE_FRESHNESS_FILE);
  const add = (label: string, expected: string, found: string | null) =>
    failures.push({ file: LANE_FRESHNESS_FILE, label, expected, found });
  const expectContains = (label: string, needle: string) => {
    if (!matrix.includes(needle)) add(label, needle, null);
  };

  expectContains("draft sign-off boundary", "**Draft for owner sign-off.**");
  expectContains("sign-off boundary heading", "## Sign-off boundary");

  for (const drift of findDocContractDrift(readDocument, [{
    file: LANE_FRESHNESS_FILE,
    id: "lane-freshness-matrix",
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    expected: renderLaneFreshnessMatrix(),
  }])) {
    failures.push({ file: drift.file, label: drift.id, expected: drift.expected, found: drift.found });
  }

  const start = matrix.indexOf(START_MARKER);
  const end = matrix.indexOf(END_MARKER);
  const outside = start < 0 || end < start ? matrix : matrix.slice(0, start) + matrix.slice(end);
  const strayRow = outside.split("\n").find((line) => line.startsWith("| `"));
  if (strayRow) add("hand-authored matrix row outside the generated block", "rows only inside the generated block", strayRow);
}

export function runDocSyncChecks(readDocument: typeof read = read): Failure[] {
  const failures: Failure[] = [];

  checkGeneratedDocContractBlocks(failures, readDocument);
  checkWorkerInfrastructureIsolateStateDoc(failures, readDocument);
  checkLaneFreshnessSignOff(failures, readDocument);
  checkRedemptionBackstopsDoc(failures, readDocument);
  const obsoleteFloorReuse = "the same floor described under Availability status above";
  if (readDocument("docs/status-dashboard.md").includes(obsoleteFloorReuse)) {
    failures.push({ file: "docs/status-dashboard.md", label: "mint/burn floor reuse", expected: `no ${obsoleteFloorReuse}`, found: obsoleteFloorReuse });
  }

  return failures;
}
