import { describe, expect, it, vi } from "vitest";
import { resolveGitleaksPin, runGitleaks } from "../ci/run-gitleaks";

describe("run-gitleaks", () => {
  it.each([
    ["linux-x64", "linux_x64.tar.gz", "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e"],
    ["linux-arm64", "linux_arm64.tar.gz", "b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f"],
    ["darwin-arm64", "darwin_arm64.tar.gz", "b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7"],
    ["darwin-x64", "darwin_x64.tar.gz", "ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5"],
  ])("selects the pinned %s release", (platformKey, assetSuffix, sha256) => {
    expect(resolveGitleaksPin(platformKey)).toEqual({ assetSuffix, sha256 });
  });

  it("returns success without bootstrapping on an unsupported lenient platform", async () => {
    const ensureBinary = vi.fn<() => Promise<string>>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runGitleaks({ argv: ["--range", "--lenient-platform"], ensureBinary, platformKey: "win32-x64" }),
    ).resolves.toEqual({ status: 0 });

    expect(ensureBinary).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[gitleaks] SKIPPED: no pinned binary for win32/x64");
    warning.mockRestore();
  });

  it("throws without bootstrapping on an unsupported strict platform", async () => {
    const ensureBinary = vi.fn<() => Promise<string>>();

    await expect(runGitleaks({ argv: ["--range"], ensureBinary, platformKey: "win32-x64" })).rejects.toThrow(
      "No pinned Gitleaks binary for win32/x64",
    );
    expect(ensureBinary).not.toHaveBeenCalled();
  });
});
