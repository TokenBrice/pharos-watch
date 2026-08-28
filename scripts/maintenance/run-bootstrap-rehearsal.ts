#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

import { selectGeneratedArtifacts } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const CHECK_PREFIX = "[check:bootstrap]";
const SOURCE_ROOTS = ["src", "shared", "worker/src", "functions", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".json"];

interface GeneratedImportOptions {
  importingFile?: string;
  repoRoot?: string;
}

interface GeneratedResolutionOptions {
  existsImpl: (path: string) => boolean;
  importingFile: string;
  repoRoot?: string;
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative));
}

function generatedBasePath(
  specifier: string,
  { importingFile, repoRoot = process.cwd() }: Omit<GeneratedResolutionOptions, "existsImpl">,
): string | null {
  const generatedRoot = resolve(repoRoot, "src/generated");
  let basePath: string;

  if (specifier.startsWith("@/generated/")) {
    basePath = resolve(generatedRoot, specifier.slice("@/generated/".length));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    basePath = resolve(dirname(importingFile), specifier);
  } else {
    return null;
  }

  return isWithin(generatedRoot, basePath) ? basePath : null;
}

function staticImportSpecifiers(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile("source.tsx", sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
}

export function extractGeneratedImportSpecifiers(
  sourceText: string,
  options: GeneratedImportOptions = {},
): string[] {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const importingFile = options.importingFile ? resolve(repoRoot, options.importingFile) : null;

  return staticImportSpecifiers(sourceText).filter((specifier) => {
    if (specifier.startsWith("@/generated/")) return true;
    if (!importingFile) return /(^|\/)generated\//.test(specifier);
    return generatedBasePath(specifier, { importingFile, repoRoot }) !== null;
  });
}

export function resolveGeneratedSpecifier(
  specifier: string,
  { existsImpl, importingFile, repoRoot = process.cwd() }: GeneratedResolutionOptions,
): string | null {
  const basePath = generatedBasePath(specifier, {
    importingFile: resolve(repoRoot, importingFile),
    repoRoot: resolve(repoRoot),
  });
  if (!basePath) return null;

  const candidates = extname(basePath)
    ? [basePath]
    : [basePath, ...RESOLUTION_EXTENSIONS.map((extension) => `${basePath}${extension}`)];
  return candidates.find((candidate) => existsImpl(candidate)) ?? null;
}

export function getBootstrapOwnedOutputPaths(): string[] {
  return [...new Set(
    selectGeneratedArtifacts({ bootstrap: true }).flatMap((artifact) => artifact.outputPaths),
  )].sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true });
    await rm(source, { force: true, recursive: true });
  }
}

function runGitStatus(repoRoot: string, outputPaths: readonly string[]): string {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...outputPaths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git status failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

async function findUnresolvedGeneratedImports(repoRoot: string): Promise<string[]> {
  const sourceFiles = (await Promise.all(
    SOURCE_ROOTS.map((sourceRoot) => collectSourceFiles(resolve(repoRoot, sourceRoot))),
  )).flat();
  const existingPaths = new Set<string>();
  const existsImpl = (path: string) => existingPaths.has(path);
  const generatedRoot = resolve(repoRoot, "src/generated");

  if (await pathExists(generatedRoot)) {
    for (const path of await collectSourceFiles(generatedRoot)) existingPaths.add(path);
    const collectJsonFiles = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collectJsonFiles(path);
        else if (entry.isFile() && extname(entry.name) === ".json") existingPaths.add(path);
      }
    };
    await collectJsonFiles(generatedRoot);
  }

  const unresolved: string[] = [];
  for (const importingFile of sourceFiles) {
    const sourceText = await readFile(importingFile, "utf8");
    const specifiers = extractGeneratedImportSpecifiers(sourceText, { importingFile, repoRoot });
    for (const specifier of specifiers) {
      if (!resolveGeneratedSpecifier(specifier, { existsImpl, importingFile, repoRoot })) {
        unresolved.push(`${relative(repoRoot, importingFile)}: ${specifier}`);
      }
    }
  }
  return unresolved.sort();
}

export async function runBootstrapRehearsal({
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
}: {
  argv?: readonly string[];
  repoRoot?: string;
} = {}): Promise<number> {
  const unknownArgs = argv.filter((arg) => arg !== "--force");
  if (unknownArgs.length > 0) throw new Error(`Unknown option(s): ${unknownArgs.join(", ")}`);

  const force = argv.includes("--force");
  const root = resolve(repoRoot);
  const outputPaths = getBootstrapOwnedOutputPaths();
  if (outputPaths.length === 0) throw new Error("The generated-artifact registry has no bootstrap-owned outputs.");
  if (outputPaths.some((path) => /[*?\[\]{}]/.test(path))) {
    throw new Error("Bootstrap-owned output paths must be concrete paths, not glob patterns.");
  }

  console.log(`${CHECK_PREFIX} protect: checking ${outputPaths.length} bootstrap-owned output(s).`);
  const dirtyStatus = runGitStatus(root, outputPaths);
  if (dirtyStatus && !force) {
    throw new Error(`Refusing to move modified bootstrap output(s); commit/stash them or pass --force:\n${dirtyStatus}`);
  }

  // Set-aside lives inside the repo (ignored via .cache/): a hard crash leaves
  // the originals discoverable next to the code instead of in a purgeable OS
  // temp directory, and same-volume renames stay atomic.
  const setAsideRoot = resolve(root, ".cache/bootstrap-rehearsal");
  const setAsideFiles = existsSync(setAsideRoot)
    ? readdirSync(setAsideRoot, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory())
    : [];
  if (setAsideFiles.length > 0) {
    throw new Error(
      `A previous rehearsal left set-aside outputs under ${setAsideRoot}; ` +
        "a run likely crashed before restoring. Inspect and move them back (or delete them if superseded) before rerunning.",
    );
  }
  const tempRoot = resolve(setAsideRoot, `set-aside-${process.pid}-${Date.now()}`);
  await mkdir(tempRoot, { recursive: true });
  const originalPaths = new Set<string>();
  let bootstrapStarted = false;
  let restored = false;
  let primaryError: unknown;

  const restoreSync = (): void => {
    if (restored) return;
    restored = true;
    // Only delete a working-tree path whose set-aside source verifiably
    // exists: rename atomicity keeps each original at exactly one of the two
    // paths, so a signal landing in any await gap can neither orphan nor
    // destroy an original — an unmoved path is simply left in place.
    for (const outputPath of originalPaths) {
      const source = resolve(tempRoot, outputPath);
      if (!existsSync(source)) continue;
      const destination = resolve(root, outputPath);
      rmSync(destination, { force: true, recursive: true });
      mkdirSync(dirname(destination), { recursive: true });
      try {
        renameSync(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        cpSync(source, destination, { recursive: true });
        rmSync(source, { force: true, recursive: true });
      }
    }
    for (const outputPath of outputPaths) {
      if (bootstrapStarted && !originalPaths.has(outputPath)) {
        rmSync(resolve(root, outputPath), { force: true, recursive: true });
      }
    }
    // Restored renames leave empty parent-directory skeletons behind; only
    // real file content blocks deletion of the set-aside root.
    const leftoverFiles = existsSync(tempRoot)
      ? readdirSync(tempRoot, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory())
      : [];
    if (leftoverFiles.length > 0) {
      throw new Error(`set-aside content remains under ${tempRoot}; refusing to delete it.`);
    }
    rmSync(setAsideRoot, { force: true, recursive: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`${CHECK_PREFIX} ${signal} received; restoring set-aside outputs before exit.`);
    try {
      restoreSync();
    } catch (error) {
      console.error(
        `${CHECK_PREFIX} restore after ${signal} failed; originals remain under ${tempRoot}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    for (const outputPath of outputPaths) {
      const absolutePath = resolve(root, outputPath);
      if (!isWithin(root, absolutePath)) throw new Error(`Bootstrap output escapes repository root: ${outputPath}`);
      if (await pathExists(absolutePath)) originalPaths.add(outputPath);
    }

    console.log(`${CHECK_PREFIX} set-aside: moving ${originalPaths.size} existing output(s).`);
    for (const outputPath of originalPaths) {
      await movePath(resolve(root, outputPath), resolve(tempRoot, outputPath));
    }

    console.log(`${CHECK_PREFIX} bootstrap: running npm run bootstrap:generated.`);
    bootstrapStarted = true;
    const bootstrap = spawnSync("npm", ["run", "bootstrap:generated"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (bootstrap.error) throw bootstrap.error;
    if (bootstrap.status !== 0) {
      const details = [bootstrap.stdout, bootstrap.stderr].map((value) => value.trim()).filter(Boolean).join("\n");
      throw new Error(`npm run bootstrap:generated failed (${bootstrap.status}).${details ? `\n${details}` : ""}`);
    }

    console.log(`${CHECK_PREFIX} imports: verifying generated module resolution.`);
    const unresolved = await findUnresolvedGeneratedImports(root);
    if (unresolved.length > 0) {
      throw new Error(`Unresolved generated import(s):\n${unresolved.map((item) => `- ${item}`).join("\n")}`);
    }

    console.log(`${CHECK_PREFIX} restore: returning set-aside outputs (rehearsal is side-effect free).`);
  } catch (error) {
    primaryError = error;
  } finally {
    // Always restore the pre-run state: git status cannot see gitignored
    // generated outputs, so keeping regenerated files would silently clobber
    // locally refreshed artifacts even on success.
    try {
      restoreSync();
    } catch (restoreError) {
      const restoreMessage =
        `restoring set-aside outputs failed; originals remain under ${tempRoot}: ` +
        `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      primaryError = primaryError
        ? new Error(`${primaryError instanceof Error ? primaryError.message : String(primaryError)}\nAdditionally, ${restoreMessage}`)
        : new Error(`Rehearsal passed but ${restoreMessage}`);
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (primaryError) throw primaryError;
  console.log(`${CHECK_PREFIX} verdict: passed.`);
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runBootstrapRehearsal().catch((error) => {
    console.error(`${CHECK_PREFIX} verdict: failed. ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
