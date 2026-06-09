import { defineConfig } from "@playwright/test";

const staticExportHost = process.env.STATIC_EXPORT_HOST ?? "127.0.0.1";
const staticExportPort = process.env.STATIC_EXPORT_PORT ?? "4173";
const staticExportBaseUrl = `http://${staticExportHost}:${staticExportPort}`;

export default defineConfig({
  testDir: "tests/visual",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: staticExportBaseUrl,
    headless: true,
  },
  webServer: {
    command: "npm run serve:static-export",
    url: staticExportBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
