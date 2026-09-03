import { buildSync } from "esbuild";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TEST_DIRECTORY = resolve(import.meta.dirname);
const HEAP_LIMIT_MIB = 128;
let temporaryDirectory = "";
let bundledProbe = "";

describe("Safety Score V9 canonical publication resource budget", {
  timeout: 60_000,
}, () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pharos-v9-resource-"));
    bundledProbe = join(temporaryDirectory, "probe.mjs");
    buildSync({
      stdin: {
        contents: `
          import { normalizeFixedInput } from "../report-cards-fixed-input.ts";
          import { buildSafetyScoreV9PublicationFromNormalizedInput } from "../safety-score-v9/candidate.ts";
          import { parseSafetyScoreV9Publication, serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec.ts";
          import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment.ts";
          import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input.ts";

          const input = normalizeFixedInput(createSafetyScoreV9FullRegistryInput());
          let prior = buildSafetyScoreV9PublicationFromNormalizedInput({
            fixedInput: input,
            publishedAtSec: input.clockSec,
          });
          let acceptedStored = await serializeSafetyScoreV9Publication(prior.candidate);
          prior = null;
          await new Promise((resolve) => setImmediate(resolve));
          globalThis.gc?.();
          let accepted = await parseSafetyScoreV9Publication(acceptedStored);
          const acceptedBaseline = buildSafetyScoreV9AcceptedPublicationBaseline(accepted);
          accepted = null;
          acceptedStored = null;
          await new Promise((resolve) => setImmediate(resolve));
          globalThis.gc?.();
          const result = buildSafetyScoreV9PublicationFromNormalizedInput({
            fixedInput: input,
            publishedAtSec: input.clockSec,
          });
          const stored = await serializeSafetyScoreV9Publication(result.candidate);
          const metadata = JSON.parse(stored);
          process.stdout.write(JSON.stringify({
            expected: input.activeAssetIds.length,
            cards: result.candidate.cards.length,
            rated: result.candidate.completeness.ratedCount,
            factDigest: result.candidate.factSetDigest,
            resultDigest: result.candidate.resultDigest,
            acceptedBaselineBytes: new TextEncoder().encode(
              JSON.stringify(acceptedBaseline),
            ).byteLength,
            candidateBytes: new TextEncoder().encode(
              JSON.stringify(result.candidate),
            ).byteLength,
            compressedBytes: metadata.compressedBytes,
            storedBytes: stored.length,
          }));
        `,
        loader: "ts",
        resolveDir: TEST_DIRECTORY,
        sourcefile: "safety-score-v9-resource-probe.ts",
      },
      outfile: bundledProbe,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      tsconfig: join(ROOT, "tsconfig.json"),
      logLevel: "silent",
    });
  });

  afterAll(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the deterministic fixture materially representative", () => {
    const fixedInput = createSafetyScoreV9FullRegistryInput();
    const extension =
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput);
    const researchEvidenceCount = extension.assets.reduce(
      (count, asset) => count + asset.researchEvidence.length,
      0,
    );
    const componentEvidenceCount = extension.assets.reduce(
      (count, asset) => count + asset.componentEvidence.length,
      0,
    );

    expect(extension.assets.length).toBeGreaterThan(300);
    expect(stableJsonStringifyV1(extension).length).toBeGreaterThan(6_500_000);
    expect(researchEvidenceCount).toBeGreaterThan(5_000);
    expect(componentEvidenceCount).toBeGreaterThan(3_000);
  });

  it(`publishes the full registry within ${HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_LIMIT_MIB}`,
        "--expose-gc",
        bundledProbe,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      expected: number;
      cards: number;
      rated: number;
      factDigest: string;
      resultDigest: string;
      acceptedBaselineBytes: number;
      candidateBytes: number;
      compressedBytes: number;
      storedBytes: number;
    };
    expect(output.expected).toBeGreaterThan(300);
    expect(output.cards).toBe(output.expected);
    expect(output.rated).toBeGreaterThan(output.expected / 3);
    expect(output.factDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.acceptedBaselineBytes).toBeLessThan(500_000);
    expect(output.candidateBytes).toBeLessThan(8_000_000);
    expect(output.compressedBytes).toBeLessThan(1_350_000);
    expect(output.storedBytes).toBeGreaterThan(0);
  });
});
