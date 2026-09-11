import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

function withCleanup<T>(run: () => T, cleanup: () => void): T {
  let result: T;
  try {
    result = run();
    if (result != null && (typeof result === "object" || typeof result === "function")
      && "then" in result && typeof result.then === "function") {
      return Promise.resolve(result).finally(cleanup) as T;
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
  return result;
}

export function withEnv<T>(key: string, value: string | undefined, run: () => T): T {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  return withCleanup(run, () => {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

export function withTempRepo<T>(
  prefix: string,
  files: Record<string, string>,
  run: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return withCleanup(() => {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = join(dir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    return run(dir);
  }, () => {
    rmSync(dir, { recursive: true, force: true });
  });
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
