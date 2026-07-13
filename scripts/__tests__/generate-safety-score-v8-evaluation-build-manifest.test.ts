import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  V8_EVALUATION_BUILD_DIGEST_DOMAIN,
  V8_EVALUATION_BUILD_SOURCE_PATHS,
  buildV8EvaluationBuildManifest,
  collectV8EvaluationBuildSourcePaths,
  renderV8EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v8-evaluation-build-manifest";

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-v8-build-manifest-"));
  for (const path of V8_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  return root;
}

describe("Safety Score v8 evaluation-build manifest", () => {
  it("covers retained score construction without Worker orchestration", () => {
    const root = fixtureRoot();
    const paths = collectV8EvaluationBuildSourcePaths(root);

    expect(paths).toContain("worker/src/lib/report-cards-snapshot-card.ts");
    expect(paths).toContain("shared/lib/report-card-overall.ts");
    expect(paths).toContain("shared/lib/report-card-peg-liquidity.ts");
    expect(paths).toContain("shared/lib/dependency-derivation.ts");
    expect(paths).toContain("shared/lib/methodology-versions/current-version.json");
    expect(paths).toContain("shared/data/methodology-changelogs/safety-score/v8.ts");
    expect(paths).not.toContain("worker/src/lib/report-cards-snapshot.ts");
    expect(paths).not.toContain("worker/src/lib/report-cards-snapshot-inputs.ts");
    expect(paths).not.toContain("shared/data/stablecoins/coins.generated.json");
    expect(buildV8EvaluationBuildManifest(root)).toEqual(buildV8EvaluationBuildManifest(root));
  });

  it("changes for scoring or retained-methodology changes without inventing a policy digest", () => {
    const root = fixtureRoot();
    const before = buildV8EvaluationBuildManifest(root);
    writeFileSync(resolve(root, "shared/lib/report-card-overall.ts"), "changed scoring\n");
    const scoreChanged = buildV8EvaluationBuildManifest(root);
    writeFileSync(resolve(root, "shared/lib/methodology-versions/current-version.json"), '{"currentVersion":"8.18"}\n');
    const methodologyChanged = buildV8EvaluationBuildManifest(root);

    expect(scoreChanged.domain).toBe(V8_EVALUATION_BUILD_DIGEST_DOMAIN);
    expect(scoreChanged.digest).not.toBe(before.digest);
    expect(methodologyChanged.digest).not.toBe(scoreChanged.digest);
    const rendered = renderV8EvaluationBuildManifest(methodologyChanged);
    expect(rendered).toContain(methodologyChanged.digest);
    expect(rendered).not.toContain("policyDigest");
  });

  it("fails when an enumerated score contract disappears", () => {
    const root = fixtureRoot();
    rmSync(resolve(root, "shared/types/report-cards.ts"));
    expect(() => buildV8EvaluationBuildManifest(root)).toThrow(/Missing.*report-cards\.ts/);
  });
});
