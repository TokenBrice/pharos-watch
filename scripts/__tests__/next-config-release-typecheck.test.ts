import { afterEach, describe, expect, it, vi } from "vitest";

import createNextConfig from "../../next.config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("release Next.js typecheck handoff", () => {
  it("keeps Next build typechecking enabled by default", () => {
    vi.stubEnv("PHAROS_RELEASE_PR_TYPECHECKED", "");

    expect(createNextConfig("phase-production-build").typescript).toBeUndefined();
  });

  it("skips only the release build repeat after the protected PR gate", () => {
    vi.stubEnv("PHAROS_RELEASE_PR_TYPECHECKED", "1");

    expect(createNextConfig("phase-production-build").typescript).toEqual({
      ignoreBuildErrors: true,
    });
  });
});
