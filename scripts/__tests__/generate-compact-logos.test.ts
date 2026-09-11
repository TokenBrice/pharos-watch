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
async function writeNoiseLogo(logosDir: string, name: string, size: number, height = size, seed = 0x2f6e2b1): Promise<void> {
  // LCG per byte, taking the high bits (low bytes repeat with period 256):
  // keeps PNG row filters from collapsing the image to nothing.
  let state = seed;
  const data = Buffer.alloc(size * height * 3);
  for (let i = 0; i < data.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  const image = sharp(data, { raw: { width: size, height, channels: 3 } });
  await (name.endsWith(".jpg") ? image.jpeg({ quality: 100 }) : image.png()).toFile(join(logosDir, name));
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

async function makeGeneratedLogoFixture(): Promise<{ paths: CompactLogoPaths }> {
  const { paths } = makePaths();
  await writeNoiseLogo(paths.logosDir, "alpha.png", 100);
  await generateCompactLogos(paths);
  return { paths };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("generateCompactLogos", () => {
  it("contains non-square PNG and JPEG images with transparent padding", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "wide.png", 128, 64);
    await writeNoiseLogo(paths.logosDir, "tall.jpg", 64, 128);
    expect((await sharp(join(paths.logosDir, "tall.jpg")).metadata()).format).toBe("jpeg");
    expect((await generateCompactLogos(paths)).ok).toBe(true);
    for (const name of ["wide", "tall"]) {
      const { data, info } = await sharp(join(paths.compactDir, `${name}.webp`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([32, 32]);
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const coordinate = name === "wide" ? y : x;
          expect(data[(y * 32 + x) * 4 + 3]).toBe(coordinate >= 8 && coordinate < 24 ? 255 : 0);
        }
      }
    }
  });

  it("qualifies dimensions at 65 but not 64, even when only one axis exceeds the gate", async () => {
    const { paths } = makePaths();
    await writeNoiseLogo(paths.logosDir, "edge.png", 64);
    await writeNoiseLogo(paths.logosDir, "wide.png", 65, 64);
    await writeNoiseLogo(paths.logosDir, "tall.png", 64, 65);
    expect((await generateCompactLogos(paths)).generated).toBe(2);
    expect(readdirSync(paths.compactDir).sort()).toEqual(["tall.webp", "wide.webp"]);
  });

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
    const { paths } = await makeGeneratedLogoFixture();

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
  it("detects changed source pixels without writing any source, output, or map bytes", async () => {
    const { paths } = await makeGeneratedLogoFixture();
    await writeNoiseLogo(paths.logosDir, "alpha.png", 100, 100, 123);
    const files = [join(paths.logosDir, "alpha.png"), join(paths.compactDir, "alpha.webp"), paths.mapPath];
    const before = files.map((file) => readFileSync(file));
    expect((await checkCompactLogos(paths)).problems.map((problem) => problem.kind)).toEqual(["stale-output"]);
    expect(files.map((file) => readFileSync(file))).toEqual(before);
    expect(readdirSync(paths.compactDir)).toEqual(["alpha.webp"]);
  });

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
    const { paths } = await makeGeneratedLogoFixture();

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
    const { paths } = await makeGeneratedLogoFixture();

    writeFileSync(join(paths.compactDir, "alpha.webp"), Buffer.from([1, 2, 3]));

    const result = await checkCompactLogos(paths);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual(["stale-output"]);
    expect(result.problems[0].message).toContain("alpha.webp");
  });

  it("fails on an orphaned compact asset", async () => {
    const { paths } = await makeGeneratedLogoFixture();

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
