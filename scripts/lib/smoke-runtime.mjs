import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export function readEnvFirst(keys, fallback = "") {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const value = process.env[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return fallback;
}

export function isDirectRun(importMetaUrl, argv1) {
  return Boolean(argv1) && importMetaUrl === pathToFileURL(resolve(argv1)).href;
}

export function readPositiveIntEnv(key, fallback) {
  return parsePositiveInt(process.env[key], fallback);
}

export function readNonNegativeIntEnv(key, fallback) {
  return parseNonNegativeInt(process.env[key], fallback);
}

export function readBooleanEnv(key, fallback) {
  return parseBoolean(process.env[key], fallback);
}

export function readCliValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

/**
 * @param {string[]} argv
 * @param {Record<string, (context: { arg: string, argv: string[], index: number, readValue: () => string }) => void | "value" | number>} handlers
 * @param {{ allowUnknown?: boolean }} [options]
 */
export function parseCliOptions(argv, handlers, { allowUnknown = true } = {}) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const handler = handlers[arg];
    if (!handler) {
      if (!allowUnknown && arg.startsWith("--")) {
        throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }

    const result = handler({
      arg,
      argv,
      index,
      readValue: () => readCliValue(argv, index, arg),
    });
    if (result === "value") {
      index += 1;
    } else if (Number.isInteger(result) && result > index) {
      index = result;
    }
  }
}

export function normalizeRoute(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canListen(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

export function allocatePort(host, { errorMessage = "Could not allocate local port" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port == null) {
          reject(new Error(errorMessage));
        } else {
          resolve(port);
        }
      });
    });
    server.listen({ host, port: 0 });
  });
}

/**
 * @param {string} host
 * @param {{
 *   env?: Readonly<Record<string, string | undefined>>,
 *   preferredPort?: number,
 *   allocationErrorMessage?: string,
 *   onFallback?: (event: { host: string, preferredPort: number, fallbackPort: number }) => void,
 * }} [options]
 */
export async function resolveStaticExportPort(
  host,
  { env = process.env, preferredPort = 4173, allocationErrorMessage, onFallback } = {},
) {
  const explicitPort = env.STATIC_EXPORT_PORT?.trim();
  if (explicitPort) return Number.parseInt(explicitPort, 10);

  if (await canListen(host, preferredPort)) return preferredPort;

  const fallbackPort = await allocatePort(host, { errorMessage: allocationErrorMessage });
  onFallback?.({ host, preferredPort, fallbackPort });
  return fallbackPort;
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns true if `--check` appears in `argv`. Standard convention across
 * maintenance scripts that support a no-op verification mode.
 */
export function parseCheckMode(argv) {
  return argv.includes("--check");
}

/**
 * Look up a single `--name <value>` style argument in the provided argv.
 * Returns the next token, or null if the flag isn't present.
 */
export function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}
