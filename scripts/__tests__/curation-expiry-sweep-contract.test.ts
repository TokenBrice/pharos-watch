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
});
