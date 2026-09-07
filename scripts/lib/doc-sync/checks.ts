import {
  Failure,
  expectEqual,
  findLineValue,
  read,
} from "./shared";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";
import {
  ISOLATE_LOCAL_STATE_DOC_END,
  ISOLATE_LOCAL_STATE_DOC_START,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";
import { METHODOLOGY_PROVENANCE_FILES } from "./methodology-manifest";
import { findDocContractDrift } from "./contract-blocks";

function checkGeneratedDocContractBlocks(failures: Failure[]): void {
  for (const drift of findDocContractDrift(read)) {
    failures.push({
      file: drift.file,
      label: `generated doc contract ${drift.id}`,
      expected: drift.expected,
      found: drift.found,
    });
  }
}

function checkMethodologyCommitProvenance(failures: Failure[]): void {
  for (const file of METHODOLOGY_PROVENANCE_FILES) {
    const doc = read(file);
    const found = doc.match(/\*\*Commit(?:s)?:\*\* `unreleased`|commits:\s*\["unreleased"\]/)?.[0] ?? null;
    if (found !== null) {
      failures.push({
        file,
        label: "methodology commit provenance",
        expected: "real commit hashes or omitted provenance",
        found,
      });
    }
  }
}

function checkWorkerInfrastructureIsolateStateDoc(failures: Failure[]): void {
  const file = "docs/worker-infrastructure.md";
  const doc = read(file);
  const start = doc.indexOf(ISOLATE_LOCAL_STATE_DOC_START);
  const end = doc.indexOf(ISOLATE_LOCAL_STATE_DOC_END);
  const found = start >= 0 && end >= start
    ? doc.slice(start, end + ISOLATE_LOCAL_STATE_DOC_END.length)
    : null;

  expectEqual(
    failures,
    file,
    "isolate-local state registry",
    found,
    renderIsolateLocalStateDocumentation(),
  );
}

function checkRedemptionBackstopsDoc(failures: Failure[]): void {
  const file = "docs/redemption-backstops.md";
  const doc = read(file);

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

export function runDocSyncChecks(): Failure[] {
  const failures: Failure[] = [];

  checkGeneratedDocContractBlocks(failures);
  checkMethodologyCommitProvenance(failures);
  checkWorkerInfrastructureIsolateStateDoc(failures);
  checkRedemptionBackstopsDoc(failures);

  return failures;
}
