import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const action = readFileSync(resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"), "utf8");

function extractStepByNeedle(needle: string): string {
  const needleIndex = action.indexOf(needle);
  if (needleIndex === -1) {
    throw new Error(`Missing setup-workspace step containing ${needle}`);
  }

  const start = action.lastIndexOf("\n    - ", needleIndex) + 1;
  const nextStep = action.indexOf("\n    - ", needleIndex + needle.length);
  return nextStep === -1 ? action.slice(start) : action.slice(start, nextStep);
}

describe("setup-workspace caches", () => {
  it("keeps independently restorable static, Next, and browser caches", () => {
    const staticStep = extractStepByNeedle("key: static-cache-");
    const nextStep = extractStepByNeedle("key: next-cache-");
    const browserStep = extractStepByNeedle("key: browser-cache-");

    for (const step of [staticStep, nextStep, browserStep]) {
      expect(step).toContain("actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae");
      expect(step).toContain("# v5.0.5");
    }
    expect(staticStep).toContain(".cache/eslint");
    expect(staticStep).toContain("*.tsbuildinfo");
    expect(staticStep).not.toContain(".next/cache");
    expect(nextStep).toContain("path: .next/cache");
    expect(nextStep).not.toContain(".cache/eslint");
    expect(browserStep).toContain("path: ~/.cache/ms-playwright");
  });

  it("saves fresh static and Next caches only from jobs that opt in", () => {
    const staticStep = extractStepByNeedle("key: static-cache-");
    const nextStep = extractStepByNeedle("key: next-cache-");

    expect(staticStep).toContain("${{ github.job }}");
    expect(nextStep).toContain("${{ github.job }}");
    // Saving jobs get a per-run unique key (post-job save always uploads);
    // restore-only jobs get a deterministic key whose exact hit suppresses the
    // save, so every shard/coverage job stops churning the 10 GB cache quota.
    expect(staticStep).toContain(
      "${{ inputs.static-cache-save == 'true' && format('-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
    );
    expect(nextStep).toContain(
      "${{ inputs.next-cache-save == 'true' && format('-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
    );
    expect(action).toContain("static-cache-save:");
    expect(action).toContain("next-cache-save:");

    for (const step of [staticStep, nextStep]) {
      const restoreKeys = step.slice(step.indexOf("restore-keys:"));
      expect(restoreKeys).toContain("${{ github.job }}-");
      expect(restoreKeys).not.toContain("github.run_id");
      expect(restoreKeys).not.toContain("github.run_attempt");
    }
  });

  it("normalizes numeric Node inputs before keying each cache", () => {
    const keyStep = extractStepByNeedle("id: cache-key");

    expect(keyStep).toContain("RAW_NODE_VERSION: ${{ inputs.node-version }}");
    expect(keyStep).toContain('raw_node_version="${RAW_NODE_VERSION}"');
    expect(keyStep).toContain("^v?([0-9]+)(\\..*)?$");
    expect(keyStep).toContain('echo "node-key=${node_key}" >> "${GITHUB_OUTPUT}"');
    // The manifest workflow adds one workspace cache, keyed by the same normalized Node major.
    expect(action.match(/steps\.cache-key\.outputs\.node-key/g)).toHaveLength(10);
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
