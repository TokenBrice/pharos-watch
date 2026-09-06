import sharp from "sharp";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCompactLogos,
  generateCompactLogos,
  type CompactLogoPaths,
} from "../maintenance/generate-compact-logos";

/** Deterministic high-entropy PNG that clears both the size and byte gates. */
async function writeNoiseLogo(logosDir: string, name: string, size: number): Promise<void> {
  // LCG per byte, taking the high bits (low bytes repeat with period 256):
  // keeps PNG row filters from collapsing the image to nothing.
  let state = 0x2f6e2b1;
  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < data.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  await sharp(data, { raw: { width: size, height: size, channels: 3 } }).png().toFile(join(logosDir, name));
}

/** Flat-color PNG: large canvas but far below the 2500-byte gate. */
async function writeFlatLogo(logosDir: string, name: string, size: number): Promise<void> {
  await sharp({
    create: { width: size, height: size, channels: 3, background: "#405060" },
  })
    .png()
    .toFile(join(logosDir, name));
}

const roots: string[] = [];

function makePaths(): { paths: CompactLogoPaths } {
  const root = mkdtempSync(join(tmpdir(), "compact-logos-"));
  roots.push(root);
  const logosDir = join(root, "logos");
  mkdirSync(logosDir);
  return { paths: { logosDir, compactDir: join(logosDir, "compact"), mapPath: join(root, "map.generated.json") } };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("generateCompactLogos", () => {
  it("generates 32x32 variants only for logos past both gates and writes the sorted map", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await writeNoiseLogo(paths.logosDir, "beta.jpg", 80);
    await writeNoiseLogo(paths.logosDir, "tiny.png", 32); // dimension gate
    await writeFlatLogo(paths.logosDir, "flat.png", 100); // byte gate

    const result = await generateCompactLogos(paths);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.generated).toBe(2);
    expect(result.pruned).toEqual([]);
    expect(readdirSync(paths.compactDir).sort()).toEqual(["alpha.webp", "beta.webp"]);

    const compactMeta = await sharp(join(paths.compactDir, "alpha.webp")).metadata();
    expect(compactMeta.format).toBe("webp");
    expect(compactMeta.width).toBe(32);
    expect(compactMeta.height).toBe(32);

    expect(JSON.parse(readFileSync(paths.mapPath, "utf8"))).toEqual({
      "/logos/alpha.png": "/logos/compact/alpha.webp",
      "/logos/beta.jpg": "/logos/compact/beta.webp",
    });
  });

  it("prunes compact assets whose source logo disappeared", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await generateCompactLogos(paths);

    rmSync(join(paths.logosDir, "alpha.png"));
    await writeNoiseLogo(paths.logosDir, "gamma.png", 100);

    const result = await generateCompactLogos(paths);

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual(["alpha.webp"]);
    expect(readdirSync(paths.compactDir)).toEqual(["gamma.webp"]);
    expect(JSON.parse(readFileSync(paths.mapPath, "utf8"))).toEqual({
      "/logos/gamma.png": "/logos/compact/gamma.webp",
    });
  });

  it("rejects basename collisions before writing any output", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await writeNoiseLogo(paths.logosDir, "alpha.jpg", 100);

    const result = await generateCompactLogos(paths);

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["collision"]);
    expect(result.problems[0].message).toContain("alpha.png");
    expect(result.problems[0].message).toContain("alpha.jpg");
    expect(result.problems[0].message).toContain("alpha.webp");
    expect(existsSync(paths.compactDir)).toBe(false);
    expect(existsSync(paths.mapPath)).toBe(false);
  });
});

describe("checkCompactLogos", () => {
  it("passes when every committed output is fresh", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await writeNoiseLogo(paths.logosDir, "beta.jpg", 80);
    await generateCompactLogos(paths);

    const result = await checkCompactLogos(paths);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.variantCount).toBe(2);
  });

  it("fails on a stale or missing variant map", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await generateCompactLogos(paths);

    writeFileSync(paths.mapPath, "{}\n");
    const stale = await checkCompactLogos(paths);
    expect(stale.ok).toBe(false);
    expect(stale.problems.map((problem) => problem.kind)).toEqual(["stale-map"]);

    rmSync(paths.mapPath);
    const missing = await checkCompactLogos(paths);
    expect(missing.ok).toBe(false);
    expect(missing.problems.map((problem) => problem.kind)).toEqual(["stale-map"]);
  });

  it("fails on a missing compact output", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await writeNoiseLogo(paths.logosDir, "beta.jpg", 80);
    await generateCompactLogos(paths);

    rmSync(join(paths.compactDir, "beta.webp"));

    const result = await checkCompactLogos(paths);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["missing-output"]);
    expect(result.problems[0].message).toContain("beta.webp");
  });

  it("fails on a compact output whose bytes no longer match its source", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await generateCompactLogos(paths);

    writeFileSync(join(paths.compactDir, "alpha.webp"), Buffer.from([1, 2, 3]));

    const result = await checkCompactLogos(paths);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["stale-output"]);
    expect(result.problems[0].message).toContain("alpha.webp");
  });

  it("fails on an orphaned compact asset", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await generateCompactLogos(paths);

    writeFileSync(join(paths.compactDir, "orphan.webp"), Buffer.from([1, 2, 3]));

    const result = await checkCompactLogos(paths);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["orphan-output"]);
    expect(result.problems[0].message).toContain("orphan.webp");
  });

  it("fails on basename collisions as well", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
    await writeNoiseLogo(paths.logosDir, "alpha.jpg", 100);

    const result = await checkCompactLogos(paths);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["collision"]);
  });
});
