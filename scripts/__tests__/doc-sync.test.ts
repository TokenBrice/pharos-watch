import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDocSyncChecks } from "../lib/doc-sync/checks";
import { LANE_FRESHNESS_REVIEW_NOTES } from "../lib/lane-freshness-review";
import { renderLaneFreshnessMatrix, replaceLaneFreshnessMatrix } from "../maintenance/generate-lane-freshness-matrix";
import {
  DOC_CONTRACT_BLOCKS,
  docContractEndMarker,
  docContractStartMarker,
  findDocContractDrift,
  renderDocContractBlock,
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
    expect(failures.some((failure) => failure.file === RUNTIME_DOC && failure.label.startsWith("runtime configuration "))).toBe(true);
  });

  it("checks both observability enabled assignments independently", () => {
    const failures = checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace("[observability.logs]\nenabled = true", "[observability.logs]\nenabled = false"),
    });
    expect(failures).toEqual([
      { file: RUNTIME_DOC, label: "runtime configuration observability.logs.enabled", expected: "true", found: "false" },
    ]);
  });

  it("rejects a missing runtime field in either the docs or the source", () => {
    for (const file of [RUNTIME_DOC, "worker/wrangler.toml"]) {
      const text = file === RUNTIME_DOC ? runtimeDoc : publicToml;
      expect(checkWithOverrides({ [file]: text.replace(/^keep_names\s*=.*\n/m, "") })).toEqual([
        {
          file,
          label: "runtime configuration root.keep_names",
          expected: file === RUNTIME_DOC ? "true" : "declared",
          found: null,
        },
      ]);
    }
  });

  it.each([
    runtimeDoc.replace("## Runtime Limits and Observability", "## Other Runtime Notes"),
    runtimeDoc.replace("```toml", "```text"),
    "## Runtime Limits and Observability\nNo snippet.\n## Another Section\n```toml\nminify = true\n```",
  ])("rejects a missing TOML snippet in the owning section", (document) => {
    expect(checkWithOverrides({ [RUNTIME_DOC]: document })).toEqual([
      { file: RUNTIME_DOC, label: "runtime limits snippet", expected: "toml runtime limits snippet", found: null },
    ]);
  });

  it("ignores comments and insignificant assignment whitespace", () => {
    expect(checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace("minify = true", "minify   =   true # documented setting"),
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

    const flowMap = "docs/data-flow-map.md";
    expect(checkWithOverrides({
      [flowMap]: readFileSync(resolve(ROOT, flowMap), "utf8").replace("past the 2h consumer budget", ""),
    })).toEqual([
      { file: flowMap, label: "Safety consumer budget", expected: "past the 2h consumer budget", found: null },
    ]);
  });
});

describe("doc-sync methodology owner sentences", () => {
  it("rejects a methodology page owner doc that drops the shared rule", () => {
    const pricing = "docs/pricing-pipeline.md";
    const depeg = "docs/depeg-detection.md";
    const pricingDrift = readFileSync(resolve(ROOT, pricing), "utf8").replace(
      "the aggregate is withheld once an overlapping protocol candidate passes registry, freshness, price and TVL checks, even when every lane then fails corroboration.",
      "",
    );
    const depegDrift = readFileSync(resolve(ROOT, depeg), "utf8").replace(
      "`confirm_required` direction changes keep the old-direction lifecycle open",
      "",
    );
    expect(checkWithOverrides({ [pricing]: pricingDrift, [depeg]: depegDrift })).toEqual([
      {
        file: pricing,
        label: "aggregate DEX suppression owner",
        expected: "the aggregate is withheld once an overlapping protocol candidate passes registry, freshness, price and TVL checks, even when every lane then fails corroboration.",
        found: null,
      },
      {
        file: depeg,
        label: "confirm-required direction lifecycle owner",
        expected: "`confirm_required` direction changes keep the old-direction lifecycle open",
        found: null,
      },
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
      const document = documents.get(file)!;
      return file === block.file
        ? document.replace(renderDocContractBlock(block), `${docContractStartMarker(block.id)}drift${docContractEndMarker(block.id)}`)
        : document;
    });

    expect(drift.map((entry) => entry.id)).toContain(block.id);
  });

  it("rejects duplicate markers even when the first block is current", () => {
    const block = DOC_CONTRACT_BLOCKS[0];
    for (const extra of [renderDocContractBlock(block), docContractStartMarker(block.id), docContractEndMarker(block.id)]) {
      const drift = findDocContractDrift((file) => documents.get(file)! + (file === block.file ? extra : ""));
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
