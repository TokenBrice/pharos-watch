import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLighthouseChildEnv,
  printScoreSummary,
} from "../maintenance/lighthouse-static-export";

describe("createLighthouseChildEnv", () => {
  it("passes only runtime essentials to npx and omits loaded secrets", () => {
    const env = createLighthouseChildEnv({
      CHROME_PATH: "/usr/bin/chromium",
      LIGHTHOUSE_PACKAGE: "malicious-lighthouse",
      PATH: "/usr/bin",
      PHAROS_API_KEY: "secret",
      SITE_PROXY_SHARED_SECRET: "secret",
      STATIC_EXPORT_HOST: "127.0.0.1",
    });

    expect(env).toEqual({
      CHROME_PATH: "/usr/bin/chromium",
      PATH: "/usr/bin",
    });
  });
});

describe("Lighthouse step summary", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  it("records measured scores and the threshold before reporting a below-threshold failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "lighthouse-summary-"));
    directories.push(directory);
    const summary = join(directory, "summary.md");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    expect(() => printScoreSummary({
      categories: { performance: { score: 0.6 } },
      audits: { "largest-contentful-paint": { displayValue: "4.2 s" } },
    }, "/stablecoin/usdc-circle/", 70, "devtools", "mobile")).toThrow("score 60 is below threshold 70");
    expect(readFileSync(summary, "utf8")).toContain("| Score | 60 |");
    expect(readFileSync(summary, "utf8")).toContain("| LCP | 4.2 s |");
    expect(readFileSync(summary, "utf8")).toContain("score threshold: 70");
  });
});
