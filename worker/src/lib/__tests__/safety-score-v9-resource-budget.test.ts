import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { assessSafetyScoreV9ResourceBudget } from "../safety-score-v9/resource-budget";
import { buildResourcePressure } from "../cron-resource-pressure";
import { REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES } from "../report-cards-fixed-input-cache-codec";
import { createResourceProbeEnv } from "./safety-score-v9-resource-env.test-support";
import { buildSafetyScoreV9ContagionProbe } from "./safety-score-v9-resource-budget.test-support";
import { hasV9ContagionInput } from "../../../scripts/lib/v9-resource-policy";
import { measurePublicationByteBudget, PublicationByteMetricsSchema, RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES, RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES } from "@shared/lib/safety-score-v9-resource-bytes";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES } from "@shared/lib/safety-score-v9-publication-limits";

describe("Safety Score V9 incremental publication byte budgets", () => {
  it("counts canonical UTF-8 card units and allows streamed cohorts above the former aggregate guard", () => {
    const cards = [{ id: "unit-a", text: "é漢🙂\ud800" }, { id: "unit-b", text: "x" }];
    const metrics = measurePublicationByteBudget({ cards }, 8_158_138);
    expect(metrics).toEqual({ unit: "card", units: 2, largestUnitBytes: Buffer.byteLength(JSON.stringify(cards[0])),
      unitLimitBytes: RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES, streamedTotalBytes: 8_158_138,
      streamedTotalRegressionLimitBytes: RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES,
      streamedTotalLimitBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES });
  });

  it("enforces calibrated per-unit and aggregate regression bounds below the hard cap", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ id: "unit", text: "" }));
    const card = { id: "unit", text: "x".repeat(RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES - overhead) };
    const metrics = measurePublicationByteBudget({ cards: [card] }, RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES);
    expect(metrics.largestUnitBytes).toBe(RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES);
    const oversizedCard = { ...card, text: `${card.text}x` };
    expect(() => measurePublicationByteBudget({ cards: [oversizedCard] },
      RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES)).toThrow("synthetic-publication-card-unit-byte-budget:unit");
    expect(() => measurePublicationByteBudget({ cards: [{ id: "unit" }] },
      SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES + 1)).toThrow();
    expect(() => measurePublicationByteBudget({ cards: [{ id: "unit" }] },
      RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES + 1)).toThrow();
    expect(RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES).toBe(8_250_000);
    expect(RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES).toBe(106_404);
    expect(RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES).toBeLessThan(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES);
    for (const change of [{ largestUnitBytes: RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES + 1 },
      { unitLimitBytes: RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES + 1 },
      { streamedTotalLimitBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES + 1 },
      { streamedTotalRegressionLimitBytes: RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES + 1 },
      { streamedTotalBytes: 0 }, { units: 0 }]) {
      expect(() => PublicationByteMetricsSchema.parse({ ...metrics, ...change })).toThrow();
    }
  });
});

describe("Safety Score V9 compile admission", () => {
  it.each([
    [520, 397, true],
    [521, 397, false],
    [520, 398, false],
  ])("admits catalog %i and active %i without slicing", (catalogAssets, activeAssets, admitted) => {
    const result = assessSafetyScoreV9ResourceBudget({
      catalogAssets, activeAssets, inputBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES,
    });
    expect(result).toEqual({
      admitted, reason: admitted ? null : "resource-budget-exceeded",
      resourcePressure: {
        phase: "compile-admission", observedAt: expect.any(Number),
        bodyCapBytes: null, cacheCapBytes: null, cacheEntryCapBytes: null, maxConcurrentDecodes: null,
        inputCapBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES, catalogMaxAssets: 520,
        intakeBytes: null, cacheBytes: null, rejectedBodies: null,
        inputBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES, catalogAssets,
        intakeBasis: "unavailable", cacheBasis: "unavailable",
        platformOutcome: null, platformOutcomeSource: null,
        heapUsedBytes: null, heapUnavailableReason: "workers-runtime-no-heap-api",
        guard: admitted ? "approaching-resource-budget" : "resource-budget-exceeded",
      },
    });
  });

  it("uses the codec expanded-byte ceiling and preserves unknown measurement", () => {
    expect(assessSafetyScoreV9ResourceBudget({
      catalogAssets: 520, activeAssets: 397,
      inputBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES + 1,
    })).toMatchObject({ admitted: false, reason: "resource-budget-exceeded" });
    expect(assessSafetyScoreV9ResourceBudget({
      catalogAssets: 520, activeAssets: 397, inputBytes: null,
    })).toMatchObject({ admitted: true, resourcePressure: { inputBytes: null } });
  });

  it.each([
    [null, true, "within-policy"],
    [5_999_999, true, "within-policy"],
    [6_000_000, true, "approaching-resource-budget"],
    [8_000_000, true, "approaching-resource-budget"],
    [8_000_001, false, "resource-budget-exceeded"],
  ] as const)("reports input headroom at %s bytes without weakening admission", (inputBytes, admitted, guard) => {
    expect(assessSafetyScoreV9ResourceBudget({ catalogAssets: 520, activeAssets: 397, inputBytes }))
      .toMatchObject({ admitted, reason: admitted ? null : "resource-budget-exceeded", resourcePressure: { inputBytes, guard } });
  });

  it("keeps unmeasured producer fields null and assembles intake evidence", () => {
    expect(buildResourcePressure()).toMatchObject({
      phase: "not-measured", guard: "not-measured", intakeBytes: null,
      inputBytes: null, catalogAssets: null, inputCapBytes: null, catalogMaxAssets: null,
      intakeBasis: "unavailable", heapUsedBytes: null,
      heapUnavailableReason: "workers-runtime-no-heap-api",
    });
    expect(buildResourcePressure({
      phase: "supply-attribution-capture", bodyCapBytes: 1024 * 1024,
      intakeBytes: 192, rejectedBodies: 1, guard: "within-policy",
    })).toMatchObject({
      phase: "supply-attribution-capture", bodyCapBytes: 1024 * 1024,
      intakeBytes: 192, rejectedBodies: 1, intakeBasis: "actual-stream", guard: "resource-budget-exceeded",
      inputCapBytes: null, catalogMaxAssets: null, platformOutcome: null, platformOutcomeSource: null,
    });
  });

  it.each([
    {},
    { contagion: true },
    { capturePath: "/explicit/capture.json" },
  ])("isolates probe children from poisoned ambient instrumentation: %j", (protocol) => {
    const launch = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath,
      ["-p", "JSON.stringify(process.env)"], { env, encoding: "utf8" });
    const expected = {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      LANG: "C", LANGUAGE: "en", LC_ALL: "C",
      ...("contagion" in protocol ? { CONTAGION_MATRIX: "1" } : {}),
      ...("capturePath" in protocol ? { SAFETY_SCORE_V9_RESOURCE_CAPTURE: protocol.capturePath } : {}),
    };
    const env = createResourceProbeEnv({ ...expected,
      ...Object.fromEntries(["LC_lowercase", "NODE_V8_COVERAGE", "VITEST", "VITEST_WORKER_ID", "COVERAGE",
        "CONTAGION_MATRIX", "SAFETY_SCORE_V9_RESOURCE_CAPTURE", "PHAROS_V9_RESOURCE_LANE"].map(key => [key, "poison"])),
      NODE_OPTIONS: "--require=/poison/preload.cjs",
    }, protocol);
    expect(env).toEqual(expected);
    const baseline = launch({});
    expect(baseline.status, baseline.stderr).toBe(0);
    const osEnv = JSON.parse(baseline.stdout);
    expect(Object.keys(osEnv)).toEqual(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);
    const child = launch(env);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ ...expected, ...osEnv });
  });
});

const ROOT = resolve(import.meta.dirname, "../../../..");
// Frozen pre-Phase-2 BASE from 335ecb0f5, smoke-out/base-20261003-0149.json
// .pipeline.candidate encoded with stableJsonStringifyV1 and gzipCanonicalJson;
// uncompressedBytes/contentSha256 below are the persisted pre-gzip bytes.
const FROZEN_BASE = {
  path: "agents/2026-10-01-curation-pass/nr/smoke-out/base-20261003-0149.json",
  bytes: 5_253_316,
  digest: "2a2c21583cc6f8c5469824042e06af590d8d73e6c6d07b552c6982a455463a93",
  inputGenerationId: "report-cards-input:v1:ffa7cce9ff70b8c7fc050d715ae47d89026e224cc22fb5929e86f978ba230fe8",
} as const;
// Node regression bound only. Gate 0 does not establish 128 MB Worker-isolate safety.
const CONTAGION_HEAP_LIMIT_MIB = 256;
// Node-only wall allowance, raised from 60s after the complete nine-scenario probe
// measured 60,496.228465 ms in the full-suite run (2026-10-07).
// This is not a Worker CPU, byte, heap, or catalog-admission ceiling.
const CONTAGION_WALL_BUDGET_MS = 90_000;
let temporaryDirectory = "";
let bundledProbe = "";
let bundledInputs: string[] = [];

describe.skipIf(process.env.PHAROS_V9_RESOURCE_LANE !== "1")("Safety Score V9 contagion and historical capture resource budgets", {
  // Bounded by the 130-second child kill guard; keeps a wedged contagion step
  // from pushing the eight-minute lane past its job timeout.
  timeout: 150_000,
}, () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pharos-v9-resource-"));
    const built = buildSafetyScoreV9ContagionProbe(ROOT, temporaryDirectory);
    bundledProbe = built.outfile;
    bundledInputs = built.inputs;
  });

  afterAll(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("selects the contagion matrix for every input the nine-scenario probe bundles", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    // Third-party modules are pinned by the lockfiles, themselves contagion
    // inputs; CI checks out node_modules inside the repo, local worktrees may not.
    const inputs = bundledInputs
      .map((input) => relative(root, input).replaceAll("\\", "/"))
      .filter((input) => !input.startsWith("..") && !/(^|\/)node_modules\//.test(input));
    for (const expected of [
      "shared/lib/safety-score-v9/contagion.ts",
      "shared/lib/peg-score.ts",
      "shared/lib/report-card-evidence-journal.ts",
      "shared/data/stablecoins/coins.generated.json",
      "worker/src/test-helpers/v9-fixed-input.ts",
      "worker/src/lib/safety-score-v9/candidate.ts",
    ]) expect(inputs, expected).toContain(expected);
    expect(inputs.filter((input) => !hasV9ContagionInput([input]))).toEqual([]);
  });

  it("excludes broad schema barrels and sync-cron helpers from publication", () => {
    for (const path of [
      "shared/types/market.ts",
      "worker/src/cron/sync-stablecoins/shared.ts",
    ]) {
      expect(bundledInputs.some((input) => input === path || input.endsWith(`/${path}`)), path).toBe(false);
    }
  });



  // Historical capture byte-size measurement only; the faithful compute harness owns the current guard.
  it.skipIf(!process.env.SAFETY_SCORE_V9_RESOURCE_CAPTURE)("keeps the frozen same-capture production envelope within both byte budgets", () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${CONTAGION_HEAP_LIMIT_MIB}`, "--expose-gc", bundledProbe,
    ], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: createResourceProbeEnv(process.env, { capturePath: process.env.SAFETY_SCORE_V9_RESOURCE_CAPTURE }),
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { candidateBytes: number; baseInputGenerationId: string; publicationBytes: unknown };
    expect(output.baseInputGenerationId).toBe(FROZEN_BASE.inputGenerationId);
    expect(() => PublicationByteMetricsSchema.parse(output.publicationBytes)).not.toThrow();
    console.info({ basePath: FROZEN_BASE.path, baseDigest: FROZEN_BASE.digest, baseBytes: FROZEN_BASE.bytes,
      candidateBytes: output.candidateBytes, deltaBytes: output.candidateBytes - FROZEN_BASE.bytes });
  });

  it(`evaluates a bounded nine-scenario matrix within ${CONTAGION_HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(process.execPath, [
      `--max-old-space-size=${CONTAGION_HEAP_LIMIT_MIB}`, "--expose-gc", bundledProbe,
    ], {
      // Wall-clock guard only (memory is the asserted bound): v10.01 cause
      // tracing raises evaluation CPU, and shared CI runners exceeded 45s.
      cwd: ROOT, encoding: "utf8", timeout: 130_000,
      env: createResourceProbeEnv(process.env, { contagion: true }),
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      expected: number; wallMs: number;
      counts: Array<{ evaluated: number; failed: number }>;
    };
    console.info({
      probe: "nine-scenario-matrix", oldSpaceLimitMiB: CONTAGION_HEAP_LIMIT_MIB, ...output,
    });
    expect(output.expected).toBeGreaterThan(300);
    expect(output.counts).toHaveLength(9);
    for (const count of output.counts) {
      expect(count.evaluated).toBe(output.expected);
      expect(count.failed).toBe(0);
    }
    // Retain all nine full-cohort scenarios and the independent 256 MiB heap bound.
    // Shared-runner scheduling/GC time is included; leave 40s of kill headroom.
    expect(output.wallMs, `nine-scenario matrix wallMs=${output.wallMs}`).toBeLessThan(CONTAGION_WALL_BUDGET_MS);
  });
});
