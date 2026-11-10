import {
  Failure,
  findLineValue,
  read,
} from "./shared";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DATA_SURFACE_DESCRIPTORS } from "@shared/lib/data-surface-descriptors";
import { getPublicProducerGraceBudget, PUBLIC_PRODUCER_INTERVAL_SEC } from "@shared/lib/public-health";
import { FRESHNESS_RATIOS, getCacheHealthyMaxRatio, getCacheRatioThresholds } from "@shared/lib/status-thresholds";
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

const LANE_FRESHNESS_FILE = "docs/process/lane-freshness-matrix.md";
const hours = (sec: number) => `${sec / 3_600}h`;
const minutes = (sec: number) => `${sec / 60}m`;

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
  expectContains("Safety recovery note", "Safety publishes hourly at :22; :46 preparation is conditional recovery.");

  const start = matrix.indexOf("<!-- GENERATED-START: lane-freshness-matrix -->");
  const end = matrix.indexOf("<!-- GENERATED-END: lane-freshness-matrix -->");
  const outside = start < 0 || end < start ? matrix : matrix.slice(0, start) + matrix.slice(end);
  const strayRow = outside.split("\n").find((line) => line.startsWith("| `"));
  if (strayRow) add("hand-authored matrix row outside the generated block", "rows only inside the generated block", strayRow);
}

/** Sentences interpolated from cron/threshold authorities must stay in their
 * owning docs; the source constants are the only value authority. */
function checkOwningFreshnessProse(failures: Failure[], readDocument: typeof read): void {
  const expect = (file: string, label: string, needle: string) => {
    if (!readDocument(file).includes(needle)) {
      failures.push({ file, label, expected: needle, found: null });
    }
  };
  const forbid = (file: string, label: string, needle: string) => {
    if (readDocument(file).includes(needle)) {
      failures.push({ file, label, expected: `no ${needle}`, found: needle });
    }
  };

  const bands = getCacheRatioThresholds("yield-data");
  const yieldBudget = DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec;
  expect(
    "docs/yield-intelligence.md",
    "yield-data freshness bands",
    `fresh through ${(yieldBudget * bands.degraded).toLocaleString("en-US")} seconds, degraded through ${(yieldBudget * bands.stale).toLocaleString("en-US")} seconds, then stale.`,
  );
  expect(
    "docs/status-dashboard.md",
    "yield-data cache ratios",
    `\`>${bands.degraded}x\` degraded / \`>${bands.stale}x\` stale`,
  );
  expect(
    "docs/status-dashboard.md",
    "yield-data healthy max ratio",
    `\`healthyMaxRatio\` is \`${FRESHNESS_RATIOS.DEGRADED}\` by default and \`${getCacheHealthyMaxRatio("yield-data")}\` for \`yield-data\``,
  );

  const safetyInterval = CRON_INTERVALS["compute-safety-score-v9"]!;
  const consumerBudget = hours(2 * safetyInterval);
  expect(
    "docs/status-dashboard.md",
    "Safety cadence",
    `(${safetyInterval.toLocaleString("en-US")}-second cadence)`,
  );
  expect("docs/data-flow-map.md", "Safety consumer budget", `past the ${consumerBudget} consumer budget`);
  const endpointSec = DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec;
  expect(
    "docs/data-flow-map.md",
    "Safety endpoint budget multiple",
    `(12× the ${hours(endpointSec)} endpoint budget, ${hours(12 * endpointSec)})`,
  );
  expect("docs/stablecoin-detail-page.md", "Safety consumer budget", `${consumerBudget} consumer budget`);
  expect(
    "docs/dependency-map.md",
    "Safety polling window",
    `${safetyInterval / 60}-minute \`staleTime\` and ${(2 * safetyInterval) / 60}-minute \`refetchInterval\`.`,
  );

  const mintBurnEndpointSec = API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;
  const producer = getPublicProducerGraceBudget(PUBLIC_PRODUCER_INTERVAL_SEC.mintBurn);
  expect(
    "docs/status-dashboard.md",
    "mint/burn endpoint and producer vocabulary",
    `The critical \`/api/mint-burn-flows\` endpoint is fresh through ${hours(mintBurnEndpointSec * FRESHNESS_RATIOS.FRESH)} and degraded through ${hours(mintBurnEndpointSec * FRESHNESS_RATIOS.DEGRADED)}. `
      + `Public producer status is Delayed after ${minutes(producer.delayedAfterSec)}, Degraded after ${hours(producer.degradedAfterSec)} and outage after ${hours(producer.outageAfterSec)}.`,
  );
  expect(
    "docs/status-dashboard.md",
    "mint/burn internal sync window",
    `against a \`${minutes(mintBurnEndpointSec)}\` window`,
  );
  forbid(
    "docs/status-dashboard.md",
    "mint/burn floor reuse",
    "the same floor described under Availability status above",
  );
}

/** Methodology pages and their owning pipeline docs must state the same rule;
 * the page assertion lives in `src/app/methodology/page.test.tsx`, the doc
 * sentence here. */
function checkMethodologyOwnerSentences(failures: Failure[], readDocument: typeof read): void {
  const expect = (file: string, label: string, needle: string) => {
    if (!readDocument(file).includes(needle)) {
      failures.push({ file, label, expected: needle, found: null });
    }
  };
  expect(
    "docs/pricing-pipeline.md",
    "aggregate DEX suppression owner",
    "the aggregate is withheld once an overlapping protocol candidate passes registry, freshness, price and TVL checks, even when every lane then fails corroboration.",
  );
  expect(
    "docs/depeg-detection.md",
    "confirm-required direction lifecycle owner",
    "`confirm_required` direction changes keep the old-direction lifecycle open",
  );
}

export function runDocSyncChecks(readDocument: typeof read = read): Failure[] {
  const failures: Failure[] = [];

  checkGeneratedDocContractBlocks(failures, readDocument);
  checkMethodologyCommitProvenance(failures, readDocument);
  checkWorkerInfrastructureIsolateStateDoc(failures, readDocument);
  checkWorkerInfrastructureRuntimeDoc(failures, readDocument);
  checkLaneFreshnessSignOff(failures, readDocument);
  checkOwningFreshnessProse(failures, readDocument);
  checkMethodologyOwnerSentences(failures, readDocument);
  checkRedemptionBackstopsDoc(failures, readDocument);

  return failures;
}
