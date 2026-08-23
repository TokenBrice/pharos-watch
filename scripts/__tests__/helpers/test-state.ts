import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export function withEnv(key: string, value: string | undefined, run: () => void): void {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    run();
  } finally {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

export function withTempRepo(
  prefix: string,
  files: Record<string, string>,
  run: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = join(dir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createTempRepoTracker(prefix: string) {
  const tempDirs: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    tempDirs.push(root);
    return root;
  }

  function writeText(root: string, relativePath: string, content: string): void {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  function writeJson(root: string, relativePath: string, value: unknown): void {
    writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function cleanup(): void {
    for (const root of tempDirs.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  return { cleanup, makeRoot, writeJson, writeText };
}
