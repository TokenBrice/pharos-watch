import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/curation-expiry-sweep.yml", import.meta.url), "utf8");

describe("permanent curation sweep contract", () => {
  it("captures projection failure and denies both green completion and summary PR", () => {
    expect(workflow).toMatch(/projection_status=1[\s\S]*jq '\{[\s\S]*projection_status=\$\?/);
    expect(workflow).toContain('echo "projection_status=$projection_status" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("PROJECTION_STATUS: ${{ steps.generate.outputs.projection_status }}");
    expect(workflow).toMatch(/if \[ "\$REPLAY_STATUS" != 0 \][^\n]*\[ "\$PROJECTION_STATUS" != 0 \]; then\n\s+echo "::error[\s\S]*?exit 1/);
    expect(workflow).toContain("if: steps.registry_diff.outputs.has_diff == 'true' && steps.generate.outputs.projection_status == '0'");
  });

  it("migrates workflow, runbook and authored skill to the explicit scenario together", () => {
    expect(workflow).toContain("--allow-registry-mismatch --rederive-current-redemption");
    const runbook = readFileSync(new URL("../../docs/process/safety-score-curation-expiry-sweep.md", import.meta.url), "utf8");
    const skill = readFileSync(new URL("../../.codex/skills/safety-score-curation/SKILL.md", import.meta.url), "utf8");
    expect(runbook).toContain('  --rederive-current-redemption\n```');
    expect(skill).toContain("--rederive-current-redemption");
    expect(workflow).toContain("SELECT value FROM cache WHERE key = 'report-cards:fixed-input:exact'");
    expect(workflow).toContain('cron: "45 5 * * 2"');
    expect(workflow).not.toMatch(/(?:INSERT INTO|UPDATE cache|DELETE FROM|DROP TABLE)/);
  });
});
