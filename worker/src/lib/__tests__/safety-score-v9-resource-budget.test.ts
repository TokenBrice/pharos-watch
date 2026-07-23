import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const ROOT = resolve(import.meta.dirname, "../../../..");
const HEAP_LIMIT_MIB = 128;
let temporaryDirectory = "";
let bundledProbe = "";

describe("Safety Score V9 resource budget", { timeout: 60_000 }, () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pharos-v9-resource-"));
    bundledProbe = join(temporaryDirectory, "probe.mjs");
    buildSync({
      stdin: {
        contents: `
          import { buildSafetyScoreV9ShadowCandidateFromNormalizedInput } from "./worker/src/lib/safety-score-v9-candidate.ts";
          import { createSafetyScoreV9FullRegistryInput } from "./worker/src/lib/__tests__/fixtures/safety-score-v9-full-registry-input.ts";
          import { buildSafetyScoreV9ShadowEnvelope, computeSafetyScoreV9ShadowEnvelopeDigest } from "./worker/src/lib/safety-score-v9-shadow.ts";

          const fixedInput = createSafetyScoreV9FullRegistryInput();
          const shadow = buildSafetyScoreV9ShadowCandidateFromNormalizedInput({
            fixedInput,
            publishedAtSec: fixedInput.clockSec,
          });
          const envelope = buildSafetyScoreV9ShadowEnvelope({
            candidate: shadow.candidate,
            expectedActiveIds: fixedInput.activeAssetIds,
            compilerFactSchemaDigest: shadow.compilerFactSchemaDigest,
            producerCapabilityDigest: shadow.producerCapabilityDigest,
            coverageFloors: [],
          });
          process.stdout.write(JSON.stringify({
            expected: fixedInput.activeAssetIds.length,
            cards: shadow.candidate.cards.length,
            rated: shadow.candidate.completeness.ratedCount,
            supplies: Object.keys(shadow.supplyUsdById).length,
            factDigest: shadow.candidate.factSetDigest,
            resultDigest: shadow.candidate.resultDigest,
            envelopeDigest: computeSafetyScoreV9ShadowEnvelopeDigest(envelope),
          }));
        `,
        loader: "ts",
        resolveDir: ROOT,
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
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("keeps the deterministic fixture materially representative", () => {
    const fixedInput = createSafetyScoreV9FullRegistryInput();
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput);
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

  it(`compiles and evaluates the full active registry within ${HEAP_LIMIT_MIB} MiB of old-space`, () => {
    const result = spawnSync(
      process.execPath,
      [`--max-old-space-size=${HEAP_LIMIT_MIB}`, bundledProbe],
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
      supplies: number;
      factDigest: string;
      resultDigest: string;
      envelopeDigest: string;
    };
    expect(output.expected).toBeGreaterThan(300);
    expect(output.cards).toBe(output.expected);
    expect(output.rated).toBeGreaterThan(output.expected / 3);
    expect(output.supplies).toBe(output.expected);
    expect(output.factDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
