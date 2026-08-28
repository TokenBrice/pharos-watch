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

export function ensureHttpUrl(input, missingMessage = "Missing URL.") {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error(missingMessage);
  return new URL(trimmed).toString();
}

export function joinRouteUrl(baseUrl, route) {
  const parsed = new URL(baseUrl);
  const normalized = normalizeRoute(route);
  return normalized === "/" ? parsed.toString() : new URL(normalized, parsed).toString();
}

export function normalizeRouteList(input, fallback = []) {
  const routes = (input ?? "")
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean)
    .map(normalizeRoute);
  return routes.length > 0 ? Array.from(new Set(routes)) : [...fallback];
}

export function getBoundedWorkerCount(taskCount, requested, { fallback = 1, maximum = 6 } = {}) {
  if (taskCount <= 0) return 0;
  return Math.min(taskCount, maximum, parsePositiveInt(requested, fallback));
}

export function chunkWorkerItems(items, workerCount) {
  if (!Array.isArray(items) || items.length === 0 || workerCount <= 0) return [];
  const chunkSize = Math.ceil(items.length / Math.min(items.length, workerCount));
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) chunks.push(items.slice(index, index + chunkSize));
  return chunks;
}

export async function runBoundedWorkerPool(items, workerCount, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async (workerIndex) => {
    while (nextIndex < items.length) {
      const itemIndex = nextIndex++;
      results[itemIndex] = await worker(items[itemIndex], itemIndex, workerIndex);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, (_, index) => runWorker(index)));
  return results;
}

export async function retrySmokeOperation(operation, {
  retries = 0,
  delayMs = 0,
  shouldRetry = () => true,
  onRetry,
  sleepImpl = sleep,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error, attempt)) throw error;
      attempt += 1;
      onRetry?.({ attempt, error, retries, delayMs });
      await sleepImpl(delayMs);
    }
  }
}

export async function retrySmokeResult(operation, {
  retries = 0,
  delayMs = 0,
  shouldRetry,
  onRetry,
  sleepImpl = sleep,
} = {}) {
  let result = await operation(0);
  for (let retryIndex = 0; retryIndex < retries && shouldRetry(result, retryIndex); retryIndex += 1) {
    onRetry?.({ attempt: retryIndex + 1, delayMs, result, retries });
    await sleepImpl(delayMs);
    result = await operation(retryIndex + 1, result);
  }
  return result;
}

export function aggregateRouteResults(results) {
  return results.reduce((aggregate, result) => {
    aggregate.results.push(result);
    if (result?.failures?.length) aggregate.failures.push(...result.failures);
    if (result?.screenshotPath) aggregate.screenshots.push(result.screenshotPath);
    return aggregate;
  }, { failures: [], results: [], screenshots: [] });
}

export async function captureFailureScreenshot(page, path, options = {}) {
  await page.screenshot({ fullPage: true, path, ...options });
  return path;
}

export async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new Error(`[smoke-ui] Failed to load Playwright from the installed workspace dependencies: ${formatError(error)}`);
  }
}

export function getBrowserLaunchOptions(env = process.env) {
  const executablePath = (env.SMOKE_UI_BROWSER_EXECUTABLE_PATH ?? "").trim();
  if (executablePath) return { executablePath, headless: true };
  const channel = (env.SMOKE_UI_BROWSER_CHANNEL ?? "").trim();
  if (channel) return { channel, headless: true };
  if (env.GITHUB_ACTIONS === "true") return { channel: "chrome", headless: true };
  return { headless: true };
}

function isMissingPlaywrightBrowserError(error) {
  const message = formatError(error);
  return message.includes("Executable doesn't exist") || message.includes("Please run the following command");
}

export async function launchChromiumBrowser(chromium, { env = process.env, log = console.log } = {}) {
  const launchOptions = getBrowserLaunchOptions(env);
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (launchOptions.channel || launchOptions.executablePath || !isMissingPlaywrightBrowserError(error)) throw error;
    log("[smoke-ui] WARN Playwright-managed Chromium missing; retrying with system Chrome");
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

export async function withBrowserContext({ chromium, contextOptions, launch = launchChromiumBrowser }, callback) {
  const browser = await launch(chromium);
  try {
    const context = await browser.newContext(contextOptions);
    try {
      return await callback(context, browser);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canListen(host, port, { createServerImpl = createServer } = {}) {
  return new Promise((resolve) => {
    const server = createServerImpl();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

export function allocatePort(host, { errorMessage = "Could not allocate local port", createServerImpl = createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServerImpl();
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
 *   canListenImpl?: typeof canListen,
 *   allocatePortImpl?: typeof allocatePort,
 * }} [options]
 */
export async function resolveStaticExportPort(
  host,
  {
    env = process.env,
    preferredPort = 4173,
    allocationErrorMessage,
    onFallback,
    canListenImpl = canListen,
    allocatePortImpl = allocatePort,
  } = {},
) {
  const explicitPort = env.STATIC_EXPORT_PORT?.trim();
  if (explicitPort) return Number.parseInt(explicitPort, 10);

  if (await canListenImpl(host, preferredPort)) return preferredPort;

  const fallbackPort = await allocatePortImpl(host, { errorMessage: allocationErrorMessage });
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
