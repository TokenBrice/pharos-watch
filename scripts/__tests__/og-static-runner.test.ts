import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { contentSha256 } from "../lib/og-image-checks.mts";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ firefox: { launch } }));
import { runOgStaticBuild } from "../lib/og-static-runner.mts";

it("renders even when a recertified manifest matches the stale published bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pharos-og-trust-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  const svg = "<svg>new source</svg>";
  const png = "old published bytes";
  const signaturePath = join(root, "signatures.json");
  writeFileSync(join(publicDir, "card.png"), png);
  writeFileSync(signaturePath, JSON.stringify({
    generatedBy: "test", fonts: {},
    cards: [{ file: "card.png", svgSha256: contentSha256(svg), pngSha256: contentSha256(png) }],
  }, null, 2) + "\n");
  launch.mockRejectedValueOnce(new Error("renderer reached"));
  try {
    await expect(runOgStaticBuild({ check: true, family: "test", fonts: [], generatedBy: "test", publicDir,
      refreshCommand: "test", roster: [{ file: "card.png", svg }], signaturePath, stagingDir: join(root, "staging"),
    })).rejects.toThrow("renderer reached");
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
