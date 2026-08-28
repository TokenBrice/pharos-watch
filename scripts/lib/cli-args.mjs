import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { argv as processArgv } from "node:process";
import { parseArgs } from "node:util";
import { isDirectRun } from "./smoke-runtime.mjs";

/** @typedef {{ type: "string" | "boolean", short?: string, multiple?: boolean, default?: string | boolean | string[] | boolean[] }} CliOptionDefinition */
/** @typedef {{ allowNegativeValues?: readonly string[], allowPositionals?: boolean, conflicts?: readonly (readonly string[])[], options?: Record<string, CliOptionDefinition> }} StrictCliConfig */
/** @typedef {{ values: Record<string, string | boolean | string[] | boolean[] | undefined>, positionals: string[], tokens: import("node:util").ParseArgsToken[] }} StrictCliResult */

export class CliUsageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CliUsageError";
    this.exitCode = 2;
  }
}

function optionLabel(name) {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

function normalizeParseError(error) {
  if (error instanceof CliUsageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliUsageError(message, error instanceof Error ? { cause: error } : undefined);
}

/**
 * Strict argument parsing for operator-facing scripts.
 *
 * Node rejects unknown options, missing values, and unexpected positionals.
 * This wrapper additionally rejects accidental duplicate options and declared
 * conflicts. Options that intentionally repeat must set `multiple: true`.
 */
/**
 * @param {readonly string[]} argv
 * @param {StrictCliConfig} [config]
 * @returns {StrictCliResult}
 */
export function parseStrictCliArgs(
  argv,
  {
    allowNegativeValues = [],
    allowPositionals = false,
    conflicts = [],
    options = {},
  } = {},
) {
  const normalizedOptions = {
    help: { type: "boolean", short: "h" },
    ...options,
  };

  const args = [...argv];
  const negativeValueOptions = new Set(allowNegativeValues);
  for (let index = 0; index < args.length - 1; index += 1) {
    const rawName = args[index];
    if (!rawName?.startsWith("--")) continue;
    const name = rawName.slice(2);
    const next = args[index + 1];
    if (negativeValueOptions.has(name) && /^-\d/.test(next ?? "")) {
      args.splice(index, 2, `${rawName}=${next}`);
    }
  }

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals,
      options: normalizedOptions,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw normalizeParseError(error);
  }

  const occurrences = new Map();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (
      normalizedOptions[token.name]?.type === "string"
      && typeof token.value === "string"
      && token.value.trim() === ""
    ) {
      throw new CliUsageError(`${optionLabel(token.name)} requires a non-empty value`);
    }
    const count = (occurrences.get(token.name) ?? 0) + 1;
    occurrences.set(token.name, count);
    if (count > 1 && normalizedOptions[token.name]?.multiple !== true) {
      throw new CliUsageError(`${optionLabel(token.name)} may only be specified once`);
    }
  }

  for (const group of conflicts) {
    const present = group.filter((name) => occurrences.has(name));
    if (present.length > 1) {
      throw new CliUsageError(
        `${present.map(optionLabel).join(" and ")} cannot be used together`,
      );
    }
  }

  return /** @type {StrictCliResult} */ (parsed);
}

/** @param {unknown} condition @param {string} message */
export function assertCliUsage(condition, message) {
  if (!condition) throw new CliUsageError(message);
}

/** @param {unknown} value @param {string} name */
export function requireCliString(value, name) {
  assertCliUsage(typeof value === "string" && value.trim().length > 0, `${name} is required`);
  return value;
}

/** @param {string} path @param {string} contents */
export function writeJsonOutput(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** @param {unknown} value @param {{ name: string, min?: number, max?: number }} bounds */
export function parseCliInteger(value, { name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }) {
  const normalized = String(value ?? "").trim();
  assertCliUsage(/^-?\d+$/.test(normalized), `${name} must be an integer`);
  const parsed = Number(normalized);
  assertCliUsage(Number.isSafeInteger(parsed), `${name} must be a safe integer`);
  assertCliUsage(parsed >= min && parsed <= max, `${name} must be between ${min} and ${max}`);
  return parsed;
}

/**
 * @param {{ help?: unknown }} values
 * @param {string} usage
 * @param {{ write: (text: string) => unknown }} [output]
 */
export function writeCliHelpIfRequested(values, usage, output = process.stdout) {
  if (values.help !== true) return false;
  output.write(`${usage.trimEnd()}\n`);
  return true;
}

/**
 * Run a CLI entrypoint with stable process semantics:
 * usage mistakes exit 2, runtime failures exit 1, and help exits 0.
 */
/**
 * @param {() => unknown | Promise<unknown>} action
 * @param {{ label?: string, usage?: string, stderr?: { write: (text: string) => unknown } }} [options]
 */
export async function runCliEntrypoint(action, { label, usage, stderr = process.stderr } = {}) {
  try {
    await action();
  } catch (error) {
    const usageError = error instanceof CliUsageError;
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label ? `${label}: ` : ""}${message}\n`);
    if (usageError && usage) stderr.write(`\n${usage.trimEnd()}\n`);
    process.exitCode = usageError ? 2 : 1;
  }
}

/**
 * Run a CLI only when its module is the process entrypoint.
 *
 * @param {string} importMetaUrl
 * @param {() => unknown | Promise<unknown>} action
 * @param {{ label?: string, usage?: string, stderr?: { write: (text: string) => unknown } }} [metadata]
 */
export function runDirectCli(importMetaUrl, action, metadata = {}) {
  if (!isDirectRun(importMetaUrl, processArgv[1])) return false;
  void runCliEntrypoint(action, metadata);
  return true;
}
