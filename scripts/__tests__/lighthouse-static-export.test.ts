import { describe, expect, it } from "vitest";

import {
  createLighthouseChildEnv,
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
