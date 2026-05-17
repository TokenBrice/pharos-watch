/**
 * Shared helpers for `sync-*.ts` maintenance scripts that pull a snapshot
 * from a Pharos API endpoint and write a JSON mirror under `data/`.
 *
 * Extracts the URL-resolution, timestamp formatting, and file-write
 * boilerplate common to sync-digests.ts and sync-depeg-events.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getArgValue } from "./cli.mjs";

interface ResolveApiUrlOptions {
  /** CLI flag that overrides everything else, e.g. `--api-url`. */
  argName: string;
  /**
   * Ordered list of environment variables to consult after the CLI flag.
   * The first non-empty value wins.
   */
  envNames: readonly string[];
  /**
   * Path suffix to append to the resolved base, e.g. `/api/digest-archive`.
   * If the resolved URL already ends with this suffix, it is returned as-is.
   */
  apiPath: string;
  /** Script name used in the error message when nothing resolves. */
  scriptName: string;
}

/**
 * Resolve an API URL from `--api-url` or one of `envNames`, then append
 * `apiPath` unless it's already present. Throws when nothing is configured.
 */
export function resolveApiUrl(options: ResolveApiUrlOptions): string {
  const { argName, envNames, apiPath, scriptName } = options;
  const explicit =
    getArgValue(process.argv, argName) ??
    envNames.map((name) => process.env[name]).find((value) => value != null && value !== "") ??
    null;
  if (!explicit) {
    throw new Error(
      `Provide ${argName} or set ${envNames.join(" / ")} before running ${scriptName}.`,
    );
  }
  if (explicit.endsWith(apiPath)) return explicit;
  return `${explicit.replace(/\/+$/, "")}${apiPath}`;
}

/**
 * Convert a UNIX epoch in seconds to an ISO date (`YYYY-MM-DD`).
 */
export function tsToDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

interface SyncJsonOptions<T> {
  /** Destination file URL. Parent directory is created if missing. */
  writeTo: URL;
  /** Fetches the upstream payload and projects it to the final entries. */
  parse: () => Promise<readonly T[]>;
}

/**
 * Boilerplate writer: run `parse()`, mkdir the destination directory, write
 * pretty JSON with a trailing newline, return the entries plus the resolved
 * filesystem path so callers can log or inspect.
 */
export async function syncJson<T>(
  options: SyncJsonOptions<T>,
): Promise<{ entries: readonly T[]; outputFile: string }> {
  const { writeTo, parse } = options;
  const entries = await parse();
  const outputFile = fileURLToPath(writeTo);
  mkdirSync(new URL(".", writeTo), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(entries, null, 2) + "\n");
  return { entries, outputFile };
}
