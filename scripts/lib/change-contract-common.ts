import { normalizeRepoPath } from "./deploy-impact.mts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { DocReference } from "./doc-ownership-registry.mts";



export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const require = createRequire(import.meta.url);

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function formatDocReference(doc: DocReference): string {
  return doc.anchor ? `${doc.path}#${doc.anchor}` : doc.path;
}
export function normalizeChangedFiles(files: readonly string[]): string[] {
  return unique(files.map((file) => normalizeRepoPath(file.trim())).filter(Boolean)).sort();
}
