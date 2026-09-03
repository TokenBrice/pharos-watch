import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getOgCaptureValidationError } from "../lib/og-capture-validation.mts";

describe("OG screenshot capture", () => {
  it("accepts a successful Pharos application document", () => {
    expect(
      getOgCaptureValidationError({
        status: 200,
        hasMainContent: true,
        bodyText: "Pharos stablecoin analytics",
      }),
    ).toBeNull();
  });

  it.each(["pharos.watch Performing security verification", "Verify you are human by completing the action below"])(
    "rejects a Cloudflare challenge page: %s",
    (bodyText) => {
      expect(
        getOgCaptureValidationError({
          status: 200,
          hasMainContent: false,
          bodyText,
        }),
      ).toBe("Cloudflare security challenge rendered instead of the application");
    },
  );

  it("rejects failed responses and documents without the application shell", () => {
    expect(getOgCaptureValidationError({ status: 403, hasMainContent: false, bodyText: "Forbidden" })).toBe(
      "expected a successful document response, received HTTP 403",
    );
    expect(getOgCaptureValidationError({ status: 200, hasMainContent: false, bodyText: "Unexpected page" })).toBe(
      'missing required "#main-content" application shell',
    );
  });

  it("uses the production Pages project domain and wires fail-closed capture handling", () => {
    const workflow = parseYaml(readFileSync(resolve(process.cwd(), ".github/workflows/og-refresh.yml"), "utf8")) as {
      jobs: { refresh: { steps: Array<{ name?: string; env?: Record<string, string> }> } };
    };
    const captureStep = workflow.jobs.refresh.steps.find(
      (step) => step.name === "Capture OG screenshots from production",
    );
    const script = readFileSync(resolve(process.cwd(), "scripts/maintenance/screenshot-og.mjs"), "utf8");

    expect(captureStep?.env).toEqual({
      OG_BASE_URL: "https://stablecoin-dashboard.pages.dev",
    });
    expect(script).toContain("const validationError = getOgCaptureValidationError({");
    expect(script).toContain("throw new Error(`${validationError} at ${page.url()}`);");
    expect(script).toContain("if (failures.length > 0) {");
    expect(script).toContain("process.exitCode = 1;");
  });

  it("keeps retired screenshots out of the capture roster", () => {
    const script = readFileSync(resolve(process.cwd(), "scripts/maintenance/screenshot-og.mjs"), "utf8");
    for (const file of [
      "about",
      "cemetery",
      "depeg",
      "learn-mechanisms",
      "safety-scores",
      "stability-index",
      "digest",
      "methodology",
    ].map((name) => `og-${name}.png`)) {
      expect(script).not.toContain(file);
    }
  });

  it("routes all static SVG families through the shared runner", () => {
    for (const file of [
      "build-og-editorial.mjs",
      "build-og-learn-images.ts",
      "build-og-case-studies.ts",
    ]) {
      const script = readFileSync(resolve(process.cwd(), "scripts/maintenance", file), "utf8");
      const runnerImport = script.match(
        /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/lib\/og-static-runner\.mts["'];/,
      );
      const importedNames = runnerImport?.[1].split(",").map((name) => name.trim()) ?? [];

      expect(importedNames).toEqual(expect.arrayContaining(["runOgStaticCli", "runOgStaticMain"]));
      expect(script.match(/\brunOgStaticCli\s*\(\{/g)).toHaveLength(1);
      expect(script.match(/\brunOgStaticMain\s*\(import\.meta\.url,\s*main\);/g)).toHaveLength(1);
    }

    const screenshotScript = readFileSync(
      resolve(process.cwd(), "scripts/maintenance/screenshot-og.mjs"),
      "utf8",
    );
    expect(screenshotScript.match(/\.\.\/lib\/og-static-runner\.mts/g)).toBeNull();
    expect(screenshotScript.match(/\brunOgStatic(?:Build|Cli|Main)\s*\(/g)).toBeNull();
  });
});
