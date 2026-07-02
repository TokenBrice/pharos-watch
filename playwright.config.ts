import { defineConfig } from "@playwright/test";

const staticExportHost = process.env.STATIC_EXPORT_HOST ?? "127.0.0.1";
const staticExportPort = process.env.STATIC_EXPORT_PORT ?? "4173";
const staticExportBaseUrl = `http://${staticExportHost}:${staticExportPort}`;

export default defineConfig({
  testDir: "tests/visual",
  // The a11y specs are one-route-per-test with no shared state, so they can
  // spread within a single file; 3 workers keeps the hydrated lane's API load
  // in the same range as the smoke-ui runs that share its server.
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: staticExportBaseUrl,
    headless: true,
  },
  webServer: {
    command: "npm run serve:static-export",
    url: staticExportBaseUrl,
    // The deploy pipeline points hydrated a11y at its already-running
    // API-backed smoke server (PLAYWRIGHT_REUSE_SERVER=1); every other lane
    // gets a fresh server so stale processes can't mask config drift.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 120_000,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
