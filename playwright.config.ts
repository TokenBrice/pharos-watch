import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/visual",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
  },
  webServer: {
    command: "npm run serve:static-export",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
