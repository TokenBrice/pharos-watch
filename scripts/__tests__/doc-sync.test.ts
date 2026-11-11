import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDocContractsCli } from "../maintenance/generate-doc-contracts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { runDocSyncChecks } from "../lib/doc-sync/checks";
import { LANE_FRESHNESS_REVIEW_NOTES } from "../lib/lane-freshness-review";
import { renderLaneFreshnessMatrix, replaceLaneFreshnessMatrix } from "../maintenance/generate-lane-freshness-matrix";
import {
  DOC_CONTRACT_BLOCKS,
  docContractEndMarker,
  docContractStartMarker,
  findDocContractDrift,
  getDocContractRegions,
  renderDocContractBlock,
  replaceDocContractRegions,
} from "../lib/doc-sync/contract-blocks";
import {
  ISOLATE_LOCAL_STATE_DOC_END,
  ISOLATE_LOCAL_STATE_DOC_START,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";
import { renderOperatorOriginAccessEnvBlock } from "@shared/lib/env-contract";

const ROOT = resolve(import.meta.dirname, "../..");
const RUNTIME_DOC = "docs/worker-infrastructure.md";
const ISOLATE_DOC = "docs/process/worker-infrastructure-appendix.md";
const runtimeDoc = readFileSync(resolve(ROOT, RUNTIME_DOC), "utf8");
const publicToml = readFileSync(resolve(ROOT, "worker/wrangler.toml"), "utf8");

function checkWithOverrides(overrides: Record<string, string>) {
  return runDocSyncChecks((file) => overrides[file] ?? readFileSync(resolve(ROOT, file), "utf8"));
}

describe("doc-sync Worker runtime documentation", () => {
  it("accepts the source-owned runtime snippet", () => {
    expect(checkWithOverrides({})).toEqual([]);
  });

  it("rejects reuse of the availability floor for mint/burn sync freshness", () => {
    const file = "docs/status-dashboard.md";
    expect(checkWithOverrides({ [file]: readFileSync(resolve(ROOT, file), "utf8") + "the same floor described under Availability status above" }))
      .toEqual([expect.objectContaining({ file, label: "mint/burn floor reuse" })]);
  });

  it.each([
    ["compatibility_date", /^compatibility_date\s*=.*$/gm, '"wrong-date"'],
    ["compatibility_flags", /^compatibility_flags\s*=.*$/gm, "[]"],
    ["preview_urls", /^preview_urls\s*=.*$/gm, "false"],
    ["minify", /^minify\s*=.*$/gm, "false"],
    ["keep_names", /^keep_names\s*=.*$/gm, "false"],
    ['"#pharos-full-catalog"', /^"#pharos-full-catalog"\s*=.*$/gm, '"./wrong-catalog.ts"'],
    ["cpu_ms", /^cpu_ms\s*=.*$/gm, "1"],
    ["enabled", /^enabled\s*=.*$/gm, "false"],
    ["head_sampling_rate", /^head_sampling_rate\s*=.*$/gm, "1"],
    ["invocation_logs", /^invocation_logs\s*=.*$/gm, "false"],
  ])("rejects documented runtime drift in %s", (key, pattern, value) => {
    const failures = checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace(pattern, `${key} = ${value}`),
    });
    expect(failures.some((failure) => failure.file === RUNTIME_DOC && failure.label === "generated doc contract worker-runtime-limits")).toBe(true);
  });

  it("checks both observability enabled assignments independently", () => {
    const failures = checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace("[observability.logs]\nenabled = true", "[observability.logs]\nenabled = false"),
    });
    expect(failures).toEqual([expect.objectContaining({ file: RUNTIME_DOC, label: "generated doc contract worker-runtime-limits" })]);
  });

  it("rejects a missing runtime field in either the docs or the source", () => {
    expect(checkWithOverrides({ [RUNTIME_DOC]: runtimeDoc.replace(/^keep_names\s*=.*\n/m, "") }))
      .toEqual([expect.objectContaining({ file: RUNTIME_DOC, label: "generated doc contract worker-runtime-limits" })]);
    expect(() => checkWithOverrides({ "worker/wrangler.toml": publicToml.replace(/^keep_names\s*=.*\n/m, "") }))
      .toThrow("missing runtime configuration root.keep_names");
  });

  it.each([
    runtimeDoc.replace("```toml", "```text"),
    "## Runtime Limits and Observability\nNo snippet.\n## Another Section\n```toml\nminify = true\n```",
  ])("rejects a missing or malformed generated TOML snippet", (document) => {
    expect(checkWithOverrides({ [RUNTIME_DOC]: document }))
      .toEqual([expect.objectContaining({ file: RUNTIME_DOC, label: "generated doc contract worker-runtime-limits" })]);
  });

  it("ignores comments and insignificant assignment whitespace in the source", () => {
    expect(checkWithOverrides({
      "worker/wrangler.toml": publicToml.replace("minify = true", "minify   =   true # documented setting"),
    })).toEqual([]);
  });
});

describe("doc-sync lane freshness matrix", () => {
  const MATRIX = "docs/process/lane-freshness-matrix.md";
  const matrix = readFileSync(resolve(ROOT, MATRIX), "utf8");

  it("generates source-owned rows with complete review notes", () => {
    const block = renderLaneFreshnessMatrix();
    expect(matrix).toContain(block);
    for (const row of [
      "| `sync-fx-rates` | 30m | 1h C | critical |",
      "| `reserve-recovery` | 5m | 10m O | critical |",
      "| `yield-coverage-audit` | 30d nominal | 60d C | watch |",
    ]) expect(block).toContain(row);
    const missing = { ...LANE_FRESHNESS_REVIEW_NOTES };
    delete missing["sync-stablecoins"];
    for (const notes of [missing, { ...LANE_FRESHNESS_REVIEW_NOTES, unknown: "Unknown." }]) {
      expect(() => renderLaneFreshnessMatrix(notes)).toThrow("lane freshness review note");
    }
    expect(replaceLaneFreshnessMatrix(matrix, block)).toBe(matrix);
    expect(() => replaceLaneFreshnessMatrix(matrix + block, block)).toThrow("one complete");
  });

  it("rejects missing sign-off boundaries and owning prose", () => {
    const matrixDrift = matrix
      .replace("**Draft for owner sign-off.**", "")
      .replace("## Sign-off boundary", "## Notes");
    expect(checkWithOverrides({ [MATRIX]: matrixDrift })).toEqual([
      { file: MATRIX, label: "draft sign-off boundary", expected: "**Draft for owner sign-off.**", found: null },
      { file: MATRIX, label: "sign-off boundary heading", expected: "## Sign-off boundary", found: null },
    ]);
    expect(checkWithOverrides({ [MATRIX]: matrix.replace(LANE_FRESHNESS_REVIEW_NOTES["compute-safety-score-v9"], "wrong recovery cadence") }))
      .toEqual([expect.objectContaining({ file: MATRIX, label: "lane-freshness-matrix" })]);

    const flowMap = "docs/data-flow-map.md";
    expect(checkWithOverrides({
      [flowMap]: readFileSync(resolve(ROOT, flowMap), "utf8").replace(DOC_CONTRACT_BLOCKS.find(({ id }) => id === "flow-safety-consumer-budget")!.value, ""),
    })).toEqual([
      expect.objectContaining({ file: flowMap, label: "generated doc contract flow-safety-consumer-budget" }),
    ]);
  });
});

describe("doc-sync methodology owner sentences", () => {
  it("rejects a methodology page owner doc that drops the shared rule", () => {
    const pricing = "docs/pricing-pipeline.md";
    const depeg = "docs/depeg-detection.md";
    const pricingDrift = readFileSync(resolve(ROOT, pricing), "utf8").replace(
      DOC_CONTRACT_BLOCKS.find(({ id }) => id === "pricing-aggregate-dex-suppression")!.value,
      "",
    );
    const depegDrift = readFileSync(resolve(ROOT, depeg), "utf8").replace(
      DOC_CONTRACT_BLOCKS.find(({ id }) => id === "depeg-confirm-required-direction")!.value,
      "",
    );
    expect(checkWithOverrides({ [pricing]: pricingDrift, [depeg]: depegDrift })).toEqual([
      expect.objectContaining({ file: pricing, label: "generated doc contract pricing-aggregate-dex-suppression" }),
      expect.objectContaining({ file: depeg, label: "generated doc contract depeg-confirm-required-direction" }),
    ]);
  });
});

describe("doc-sync isolate-local state documentation", () => {
  it.each([
    "",
    `${ISOLATE_LOCAL_STATE_DOC_START}stale${ISOLATE_LOCAL_STATE_DOC_END}`,
    `${renderIsolateLocalStateDocumentation()}${ISOLATE_LOCAL_STATE_DOC_START}`,
    `${renderIsolateLocalStateDocumentation()}${ISOLATE_LOCAL_STATE_DOC_END}`,
  ])("rejects missing, stale or duplicate registry regions", (document) => {
    const failures = checkWithOverrides({ [ISOLATE_DOC]: document });
    expect(failures).toEqual([
      expect.objectContaining({
        file: ISOLATE_DOC,
        label: "isolate-local state registry",
        expected: renderIsolateLocalStateDocumentation(),
      }),
    ]);
  });
});

describe("generated documentation contract blocks", () => {
  const documents: ReadonlyMap<string, string> = new Map(
    [...new Set(DOC_CONTRACT_BLOCKS.map((block) => block.file))].map((file) => [file, readFileSync(resolve(ROOT, file), "utf8")]),
  );

  it.each(DOC_CONTRACT_BLOCKS)("detects drift in $id", (block) => {
    const drift = findDocContractDrift((file) => {
      const document = documents.get(file) ?? readFileSync(resolve(ROOT, file), "utf8");
      return file === block.file
        ? document.replace(renderDocContractBlock(block), `${docContractStartMarker(block.id)}drift${docContractEndMarker(block.id)}`)
        : document;
    });

    expect(drift.map((entry) => entry.id)).toContain(block.id);
    expect(checkWithOverrides({ [block.file]: documents.get(block.file)!.replace(renderDocContractBlock(block), "broken") }))
      .toContainEqual(expect.objectContaining({ file: block.file, label: `generated doc contract ${block.id}` }));
    const expected = renderDocContractBlock(block);
    const regions = [{ ...block, startMarker: docContractStartMarker(block.id), endMarker: docContractEndMarker(block.id), expected }];
    expect(replaceDocContractRegions(`before${regions[0].startMarker}drift${regions[0].endMarker}after`, regions))
      .toBe(`before${expected}after`);
    expect(replaceDocContractRegions(documents.get(block.file)!, regions)).toBe(documents.get(block.file));
    expect(() => replaceDocContractRegions(expected + expected, regions)).toThrow("exactly one complete");
  });


  it("checks without writing, refreshes stale blocks and rejects ambiguous markers before writing", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-doc-contracts-"));
    try {
      const regions = getDocContractRegions();
      expect(GENERATED_ARTIFACT_REGISTRY.find(({ id }) => id === "doc-contracts")?.outputPaths)
        .toEqual([...new Set(regions.map(({ file }) => file))].sort());
      for (const file of new Set([...regions.map((region) => region.file), "worker/wrangler.toml"])) {
        mkdirSync(dirname(resolve(root, file)), { recursive: true });
        writeFileSync(resolve(root, file), readFileSync(resolve(ROOT, file)));
      }
      const [first, second] = regions;
      const path = resolve(root, first.file);
      const original = readFileSync(path, "utf8");
      const broken = original.replace(first.expected, `${first.startMarker}broken${first.endMarker}`);
      writeFileSync(path, broken);
      expect(() => runDocContractsCli(["--check"], root)).toThrow(`${first.file}: ${first.id}`);
      expect(readFileSync(path, "utf8")).toBe(broken);
      const other = resolve(root, second.file);
      const otherOriginal = readFileSync(other, "utf8");
      writeFileSync(other, otherOriginal + second.startMarker);
      expect(() => runDocContractsCli([], root)).toThrow("exactly one complete");
      expect(readFileSync(path, "utf8")).toBe(broken);
      writeFileSync(other, otherOriginal);
      runDocContractsCli([], root);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(() => runDocContractsCli(["--check"], root)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects duplicate markers even when the first block is current", () => {
    const block = DOC_CONTRACT_BLOCKS[0];
    for (const extra of [renderDocContractBlock(block), docContractStartMarker(block.id), docContractEndMarker(block.id)]) {
      const drift = findDocContractDrift((file) => (documents.get(file) ?? readFileSync(resolve(ROOT, file), "utf8")) + (file === block.file ? extra : ""));
      expect(drift.map((entry) => entry.id)).toContain(block.id);
    }
  });

  it.each([
    {
      id: "env contract",
      file: "docs/operator-origin-access.md",
      startMarker: "<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:BEGIN -->",
      endMarker: "<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:END -->",
      content: `\n${renderOperatorOriginAccessEnvBlock()}\n`,
    },
    {
      id: "isolate-local state registry",
      file: ISOLATE_DOC,
      startMarker: ISOLATE_LOCAL_STATE_DOC_START,
      endMarker: ISOLATE_LOCAL_STATE_DOC_END,
      content: renderIsolateLocalStateDocumentation().slice(
        ISOLATE_LOCAL_STATE_DOC_START.length,
        -ISOLATE_LOCAL_STATE_DOC_END.length,
      ),
    },
  ])("compares $id with its existing explicit markers", ({ content, ...markers }) => {
    const region = { ...markers, expected: `${markers.startMarker}${content}${markers.endMarker}` };
    const compare = (document: string) => findDocContractDrift(() => document, [region]);
    expect(compare(`before\n${region.expected}\nafter`)).toEqual([]);
    expect(compare(`${markers.startMarker}stale${markers.endMarker}`)).toEqual([
      expect.objectContaining({ id: region.id, found: `${markers.startMarker}stale${markers.endMarker}` }),
    ]);
    for (const document of [
      "",
      markers.startMarker,
      markers.endMarker,
      `${markers.endMarker}${markers.startMarker}`,
      `${region.expected}${region.expected}`,
      `${region.expected}${markers.startMarker}`,
      `${region.expected}${markers.endMarker}`,
    ]) {
      expect(compare(document)).toEqual([
        { file: region.file, id: region.id, expected: region.expected, found: null },
      ]);
    }
  });
});
