import { afterEach, expect, it, vi } from "vitest";

const { spawn, resolveStaticExportPort, stopAfterSpawn } = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveStaticExportPort: vi.fn(async () => 49232),
  stopAfterSpawn: new Error("child environment captured"),
}));

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", () => ({
  existsSync: () => false,
  promises: { open: async () => { throw new Error("no log descriptor in fixture"); } },
}));
vi.mock("node:fs/promises", () => ({
  access: async () => undefined,
  writeFile: async () => undefined,
}));
vi.mock("../lib/smoke-runtime.mjs", () => ({
  resolveStaticExportPort,
  sleep: vi.fn(),
  waitForStaticExportServer: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it("keeps the selected child port and credential fallbacks when STATIC_EXPORT inputs are blank", async () => {
  vi.stubEnv("STATIC_EXPORT_HOST", "127.0.0.1");
  vi.stubEnv("STATIC_EXPORT_PORT", "");
  vi.stubEnv("STATIC_EXPORT_API_KEY", " ");
  vi.stubEnv("STATIC_EXPORT_SITE_API_SHARED_SECRET", "");
  vi.stubEnv("STATIC_EXPORT_API_BASE", "https://api.example.test");
  vi.stubEnv("SMOKE_API_KEY", " fixture-key ");
  vi.stubEnv("SITE_API_SHARED_SECRET", " fixture-secret ");
  spawn.mockImplementation(() => { throw stopAfterSpawn; });

  await expect(import("../maintenance/run-pages-smoke.mjs")).rejects.toBe(stopAfterSpawn);

  expect(resolveStaticExportPort).toHaveBeenCalledWith("127.0.0.1", expect.any(Object));
  expect(spawn).toHaveBeenCalledWith("npm", ["run", "serve:static-export"], expect.objectContaining({
    env: expect.objectContaining({
      STATIC_EXPORT_HOST: "127.0.0.1",
      STATIC_EXPORT_PORT: "49232",
      STATIC_EXPORT_API_KEY: "fixture-key",
      STATIC_EXPORT_SITE_API_SHARED_SECRET: "fixture-secret",
      STATIC_EXPORT_API_BASE: "https://api.example.test",
    }),
  }));
});
