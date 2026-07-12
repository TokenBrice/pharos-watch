import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = ".github/scripts/parse-pages-deployment-id.mjs";
const fixtures = resolve(process.cwd(), "scripts/__tests__/fixtures/pages-deployment-id");

function parseFixture(name: string) {
  return spawnSync(process.execPath, [script, resolve(fixtures, name)], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("parse-pages-deployment-id", () => {
  it.each([
    ["lowercase-id.json", "pages-deployment-current"],
    ["uppercase-id.json", "pages-deployment-uppercase"],
    ["deployment-id.json", "pages-deployment-snake-case"],
  ])("parses the current deployment from %s", (fixture, expectedId) => {
    const result = parseFixture(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`deployment_id=${expectedId}\n`);
    expect(result.stderr).toBe("");
  });

  it("warns with the observed keys when the current entry has no recognized id", () => {
    const result = parseFixture("missing-id.json");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("deployment_id=\n");
    expect(result.stderr).toContain("wrangler entry lacked a recognized deployment id field");
    expect(result.stderr).toContain("environment,url");
  });
});
