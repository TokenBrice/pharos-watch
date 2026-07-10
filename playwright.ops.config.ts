import { defineConfig } from "@playwright/test";

const staticExportHost = "127.0.0.1";
const staticExportPort = process.env.OPS_PLAYWRIGHT_PORT ?? "4174";
const staticExportServerUrl = `http://${staticExportHost}:${staticExportPort}`;
const opsBaseUrl = `http://ops.pharos.watch:${staticExportPort}`;
const phase6MatrixTag = /@phase6/;

const viewports = [
  { name: "chromium-320", width: 320, height: 568 },
  { name: "chromium-390", width: 390, height: 844 },
  { name: "chromium-768", width: 768, height: 1024 },
  { name: "chromium-1024", width: 1024, height: 768 },
  { name: "chromium-1440", width: 1440, height: 1000 },
] as const;

export default defineConfig({
  testDir: "tests/visual/ops",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "test-results/ops-browser",
  reporter: [["list"]],
  use: {
    baseURL: opsBaseUrl,
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--host-resolver-rules=MAP ops.pharos.watch 127.0.0.1", "--no-proxy-server"],
    },
  },
  projects: viewports.map(({ name, width, height }) => ({
    name,
    ...(name === "chromium-390" ? {} : { grepInvert: phase6MatrixTag }),
    use: { viewport: { width, height } },
  })),
  webServer: {
    command: "npm run serve:static-export",
    url: staticExportServerUrl,
    env: {
      STATIC_EXPORT_HOST: staticExportHost,
      STATIC_EXPORT_PORT: staticExportPort,
    },
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_OPS_SERVER === "1",
    timeout: 120_000,
  },
});
