import { describe, expect, it } from "vitest";

import {
  buildLighthouseArgs,
  createLighthouseChildEnv,
  parseArgs,
} from "../maintenance/lighthouse-static-export";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("lighthouse-static-export parseArgs", () => {
  it("defaults to mobile Lighthouse scoring", () => {
    withEnv("LIGHTHOUSE_FORM_FACTOR", undefined, () => {
      expect(parseArgs([]).formFactor).toBe("mobile");
    });
  });

  it("accepts desktop Lighthouse scoring from CLI and env", () => {
    expect(parseArgs(["--form-factor", "desktop"]).formFactor).toBe("desktop");

    withEnv("LIGHTHOUSE_FORM_FACTOR", "desktop", () => {
      expect(parseArgs([]).formFactor).toBe("desktop");
    });
  });

  it("rejects unknown Lighthouse form factors", () => {
    expect(() => parseArgs(["--form-factor", "tablet"])).toThrow("--form-factor must be one of");
  });
});

describe("buildLighthouseArgs", () => {
  it("uses desktop screen emulation for desktop audits", () => {
    const args = buildLighthouseArgs({
      formFactor: "desktop",
      reportBase: "agents/lighthouse/report",
      targetUrl: "http://127.0.0.1:4173/",
      throttlingMethod: "devtools",
    });

    expect(args).toContain("--preset=desktop");
    expect(args).not.toContain("--form-factor=desktop");
    expect(args).not.toContain("--screenEmulation.mobile=false");
  });

  it("keeps mobile screen emulation for the default audit", () => {
    const args = buildLighthouseArgs({
      formFactor: "mobile",
      reportBase: "agents/lighthouse/report",
      targetUrl: "http://127.0.0.1:4173/",
      throttlingMethod: "devtools",
    });

    expect(args).toContain("--form-factor=mobile");
    expect(args).toContain("--screenEmulation.mobile=true");
    expect(args).not.toContain("--screenEmulation.width=1350");
  });
});

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
