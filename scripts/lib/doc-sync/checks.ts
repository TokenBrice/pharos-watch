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
import { METHODOLOGY_PROVENANCE_FILES } from "./methodology-manifest";
import { findDocContractDrift } from "./contract-blocks";
import { assignmentKey, buildAssignmentMap, parseAssignments } from "../wrangler-toml.mjs";

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

function checkMethodologyCommitProvenance(failures: Failure[], readDocument: typeof read): void {
  for (const file of METHODOLOGY_PROVENANCE_FILES) {
    const doc = readDocument(file);
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

function extractRuntimeLimitsTomlSnippet(markdown: string): string | null {
  const heading = "## Runtime Limits and Observability";
  const start = markdown.indexOf(heading);
  if (start < 0) return null;
  const nextHeading = markdown.indexOf("\n## ", start + heading.length);
  const section = markdown.slice(start, nextHeading < 0 ? markdown.length : nextHeading);
  const match = section.match(/```toml\s*\n([\s\S]*?)\n```/);
  return match?.[1] ?? null;
}

function checkWorkerInfrastructureRuntimeDoc(failures: Failure[], readDocument: typeof read): void {
  const file = "docs/worker-infrastructure.md";
  const snippet = extractRuntimeLimitsTomlSnippet(readDocument(file));
  if (snippet === null) {
    failures.push({ file, label: "runtime limits snippet", expected: "toml runtime limits snippet", found: null });
    return;
  }

  const configByKey = buildAssignmentMap(parseAssignments(readDocument("worker/wrangler.toml")));
  const docsByKey = buildAssignmentMap(parseAssignments(snippet));
  for (const field of [
    { section: "root", key: "compatibility_date" },
    { section: "root", key: "compatibility_flags" },
    { section: "root", key: "preview_urls" },
    { section: "root", key: "minify" },
    { section: "root", key: "keep_names" },
    { section: "alias", key: "#pharos-full-catalog" },
    { section: "limits", key: "cpu_ms" },
    { section: "observability", key: "enabled" },
    { section: "observability", key: "head_sampling_rate" },
    { section: "observability.logs", key: "enabled" },
    { section: "observability.logs", key: "invocation_logs" },
  ]) {
    const key = assignmentKey(field.section, field.key);
    const expected = configByKey.get(key)?.replace(/\s+/g, " ").trim();
    const found = docsByKey.get(key)?.replace(/\s+/g, " ").trim();
    if (expected === undefined || found !== expected) {
      failures.push({
        file: expected === undefined ? "worker/wrangler.toml" : file,
        label: `runtime configuration ${field.section}.${field.key}`,
        expected: expected ?? "declared",
        found: expected === undefined ? null : found ?? null,
      });
    }
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

export function runDocSyncChecks(readDocument: typeof read = read): Failure[] {
  const failures: Failure[] = [];

  checkGeneratedDocContractBlocks(failures, readDocument);
  checkMethodologyCommitProvenance(failures, readDocument);
  checkWorkerInfrastructureIsolateStateDoc(failures, readDocument);
  checkWorkerInfrastructureRuntimeDoc(failures, readDocument);
  checkRedemptionBackstopsDoc(failures, readDocument);

  return failures;
}
