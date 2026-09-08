import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { getOgCaptureValidationError } from "../lib/og-capture-validation.mts";
import { runScreenshotOgCli } from "../maintenance/screenshot-og.mjs";

const capture = vi.hoisted(() => {
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForTimeout: vi.fn(),
    locator: vi.fn(() => ({ innerText: async () => "Pharos", count: async () => 1 })),
    url: () => "https://pharos.watch/",
    addStyleTag: vi.fn(),
    evaluate: vi.fn(),
    screenshot: vi.fn(async (_options: { path: string }) => {}),
    close: vi.fn(),
  };
  const context = { on: vi.fn(), newPage: vi.fn(async () => page) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
  return { page, context, browser };
});
vi.mock("playwright", () => ({ chromium: { launch: async () => capture.browser } }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<object>(),
  mkdirSync: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

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

    expect(captureStep?.env).toEqual({
      OG_BASE_URL: "https://stablecoin-dashboard.pages.dev",
    });
  });

  it.each([false, true])("executes capture with rejected document=%s", async (rejected) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    capture.page.locator.mockImplementation(() => ({
      innerText: async () => rejected ? "Verify you are human by completing the action below" : "Pharos",
      count: async () => rejected ? 0 : 1,
    }));
    try {
      await runScreenshotOgCli([]);
      expect(capture.browser.close).toHaveBeenCalledOnce();
      if (rejected) {
        expect(process.exitCode).toBe(1);
        expect(capture.context.newPage).toHaveBeenCalledOnce();
        expect(capture.page.close).toHaveBeenCalledOnce();
        expect(capture.page.screenshot).not.toHaveBeenCalled();
        expect(capture.page.addStyleTag).not.toHaveBeenCalled();
      } else {
        expect(process.exitCode).toBeUndefined();
        const files = capture.page.screenshot.mock.calls.map(([options]) => options.path.split("/").pop());
        expect(files).toContain("og-card.png");
        expect(files).toContain("og-default.png");
        for (const retired of ["about", "cemetery", "depeg", "learn-mechanisms", "safety-scores", "stability-index", "digest", "methodology"]) {
          expect(files).not.toContain(`og-${retired}.png`);
        }
      }
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
