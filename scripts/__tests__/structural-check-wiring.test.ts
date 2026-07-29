import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("structural check wiring", () => {
  it("runs every structural component through the composite command", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    const command = packageJson.scripts["check:structural"];

    expect(command).toContain("npm run check:hotspot-ratchet");
    expect(command).toContain("npm run check:cron-console-usage");
    expect(command).toContain("npm run check:provider-resilience");
    expect(command).toContain("npm run check:fetch-body-timeouts");
    expect(command).toContain("npm run check:script-entrypoints");
    expect(command).toContain("npm run check:cli-args-policy");
    expect(command).toContain("npm run check:stale-flags");
  });

  it("runs the structural composite in nightly validation", () => {
    expect(readRepoFile(".github/workflows/nightly-validation.yml")).toContain("npm run check:structural");
  });
});
