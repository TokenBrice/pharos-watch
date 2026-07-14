import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const action = readFileSync(resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"), "utf8");

function extractStepByNeedle(needle: string): string {
  const start = action.indexOf(needle);
  if (start === -1) {
    throw new Error(`Missing setup-workspace step containing ${needle}`);
  }

  const nextStep = action.indexOf("\n    - ", start + needle.length);
  return nextStep === -1 ? action.slice(start) : action.slice(start, nextStep);
}

describe("setup-workspace tooling cache", () => {
  it("keeps the cache action pinned while caching generated tooling artifacts", () => {
    const cacheStep = extractStepByNeedle("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");

    expect(cacheStep).toContain("# v5.0.5");
    expect(cacheStep).toContain(".next/cache");
    expect(cacheStep).toContain(".cache/eslint");
    expect(cacheStep).toContain("~/.cache/ms-playwright");
    expect(cacheStep).toContain("*.tsbuildinfo");
    expect(cacheStep).toContain("worker/*.tsbuildinfo");
  });

  it("saves fresh tooling caches only from jobs that opt in via tooling-cache-save", () => {
    const cacheStep = extractStepByNeedle("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");

    expect(cacheStep).toContain("${{ github.job }}");
    // Saving jobs get a per-run unique key (post-job save always uploads);
    // restore-only jobs get a deterministic key whose exact hit suppresses the
    // save, so every shard/coverage job stops churning the 10 GB cache quota.
    expect(cacheStep).toContain(
      "${{ inputs.tooling-cache-save == 'true' && format('-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
    );
    expect(action).toContain("tooling-cache-save:");

    const restoreKeys = cacheStep.slice(cacheStep.indexOf("restore-keys:"));
    expect(restoreKeys).toContain("${{ github.job }}-");
    expect(restoreKeys).not.toContain("github.run_id");
    expect(restoreKeys).not.toContain("github.run_attempt");
  });

  it("normalizes numeric Node inputs before keying the tooling cache", () => {
    const keyStep = extractStepByNeedle("id: tooling-cache-key");
    const cacheStep = extractStepByNeedle("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");

    expect(keyStep).toContain("RAW_NODE_VERSION: ${{ inputs.node-version }}");
    expect(keyStep).toContain('raw_node_version="${RAW_NODE_VERSION}"');
    expect(keyStep).toContain("^v?([0-9]+)(\\..*)?$");
    expect(keyStep).toContain('echo "node-key=${node_key}" >> "${GITHUB_OUTPUT}"');
    expect(cacheStep).toContain("${{ steps.tooling-cache-key.outputs.node-key }}");
    expect(cacheStep).not.toContain("inputs.node-version");
  });

  it("installs Playwright Chromium only when requested", () => {
    const installStep = extractStepByNeedle("inputs.install-playwright-chromium == 'true'");

    expect(installStep).toContain("inputs.install-playwright-chromium == 'true'");
    expect(installStep).toContain("npx --no-install playwright install --with-deps chromium");
  });

  it("runs bootstrap-safe generators explicitly after dependency install", () => {
    const bootstrapStep = extractStepByNeedle("npm run bootstrap:generated");

    expect(action).toContain("bootstrap-generated:");
    expect(action).toContain("inputs.install-deps == 'true' && inputs.bootstrap-generated == 'true'");
    expect(bootstrapStep).toContain("npm run bootstrap:generated");
  });

  it("installs Playwright Firefox only when requested", () => {
    const installStep = extractStepByNeedle("inputs.install-playwright-firefox == 'true'");

    expect(installStep).toContain("inputs.install-playwright-firefox == 'true'");
    expect(installStep).toContain("npx --no-install playwright install --with-deps firefox");
  });
});
