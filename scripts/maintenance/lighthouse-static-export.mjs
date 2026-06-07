#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createStaticExportServer } from "./serve-static-export.mjs";

const OUT_DIR = path.resolve("out");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_THRESHOLD = 95;
const DEFAULT_THROTTLING_METHOD = "devtools";
const DEFAULT_FORM_FACTOR = "mobile";
const LIGHTHOUSE_PACKAGE = process.env.LIGHTHOUSE_PACKAGE?.trim() || "lighthouse@13.3.0";
const ENV_FILE = path.resolve(".env.local");
const VALID_FORM_FACTORS = new Set(["mobile", "desktop"]);
const VALID_THROTTLING_METHODS = new Set(["devtools", "simulate", "provided"]);

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

export function parseArgs(argv) {
  const options = {
    formFactor: process.env.LIGHTHOUSE_FORM_FACTOR?.trim() || DEFAULT_FORM_FACTOR,
    outputDir: process.env.LIGHTHOUSE_OUTPUT_DIR?.trim() || "agents/lighthouse",
    route: process.env.LIGHTHOUSE_ROUTE?.trim() || "/",
    threshold: Number.parseInt(process.env.LIGHTHOUSE_THRESHOLD ?? String(DEFAULT_THRESHOLD), 10),
    throttlingMethod: process.env.LIGHTHOUSE_THROTTLING_METHOD?.trim() || DEFAULT_THROTTLING_METHOD,
    url: process.env.LIGHTHOUSE_URL?.trim() || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const inlinePrefix = `${name}=`;
      if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${name}`);
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--form-factor" || arg.startsWith("--form-factor=")) {
      options.formFactor = readValue("--form-factor");
    } else if (arg === "--output-dir" || arg.startsWith("--output-dir=")) {
      options.outputDir = readValue("--output-dir");
    } else if (arg === "--route" || arg.startsWith("--route=")) {
      options.route = readValue("--route");
    } else if (arg === "--threshold" || arg.startsWith("--threshold=")) {
      options.threshold = Number.parseInt(readValue("--threshold"), 10);
    } else if (arg === "--throttling-method" || arg.startsWith("--throttling-method=")) {
      options.throttlingMethod = readValue("--throttling-method");
    } else if (arg === "--url" || arg.startsWith("--url=")) {
      options.url = readValue("--url");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 100) {
    throw new Error("--threshold must be a number from 0 to 100");
  }
  if (!VALID_FORM_FACTORS.has(options.formFactor)) {
    throw new Error("--form-factor must be one of: mobile, desktop");
  }
  if (!VALID_THROTTLING_METHODS.has(options.throttlingMethod)) {
    throw new Error("--throttling-method must be one of: devtools, simulate, provided");
  }

  return options;
}

function printHelp() {
  console.log(`Run Lighthouse performance scoring against the built static export.

Usage:
  npm run lighthouse:static
  npm run lighthouse:static -- --form-factor desktop
  npm run lighthouse:static -- --route /stability-index/ --threshold 95

Options:
  --route <path>       Static-export route to audit. Default: /
  --form-factor <type> Lighthouse form factor: mobile or desktop. Default: mobile
  --threshold <0-100> Minimum performance score required. Default: 95
  --throttling-method <method> Lighthouse throttling method. Default: devtools
  --output-dir <dir>  Directory for HTML/JSON reports. Default: agents/lighthouse
  --url <url>         Audit an already-running URL instead of starting the static server
`);
}

function normalizeRoute(route) {
  if (!route || route === "/") return "/";
  return `/${route.replace(/^\/+/, "")}`;
}

function routeSlug(route) {
  return normalizeRoute(route).replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-") || "home";
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildBaseUrl(host, port) {
  return `http://${host}:${port}`;
}

function canListen(host, port) {
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

function allocatePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port == null) {
          reject(new Error("Could not allocate local Lighthouse port"));
        } else {
          resolve(port);
        }
      });
    });
    server.listen({ host, port: 0 });
  });
}

async function resolveStaticExportPort(host) {
  const explicitPort = process.env.STATIC_EXPORT_PORT?.trim();
  if (explicitPort) return Number.parseInt(explicitPort, 10);

  const preferredPort = 4173;
  if (await canListen(host, preferredPort)) return preferredPort;
  return allocatePort(host);
}

async function waitForReady(url) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 400) return;
    } catch {
      // Server still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Static export server did not become ready at ${url}`);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function auditDisplayValue(audit) {
  return audit?.displayValue ?? "n/a";
}

function buildScreenEmulationArgs(formFactor) {
  if (formFactor === "desktop") {
    return [
      "--screenEmulation.mobile=false",
      "--screenEmulation.width=1350",
      "--screenEmulation.height=940",
      "--screenEmulation.deviceScaleFactor=1",
    ];
  }

  return ["--screenEmulation.mobile=true"];
}

export function buildLighthouseArgs({ formFactor, reportBase, targetUrl, throttlingMethod }) {
  const deviceArgs =
    formFactor === "desktop" ? ["--preset=desktop"] : [`--form-factor=${formFactor}`, ...buildScreenEmulationArgs(formFactor)];

  return [
    "--yes",
    LIGHTHOUSE_PACKAGE,
    targetUrl,
    "--only-categories=performance",
    "--output=json",
    "--output=html",
    `--output-path=${reportBase}`,
    ...deviceArgs,
    `--throttling-method=${throttlingMethod}`,
    "--chrome-flags=--headless=new --no-sandbox",
    "--quiet",
  ];
}

function printScoreSummary(report, reportPath, threshold, throttlingMethod, formFactor) {
  const score = Math.round((report.categories.performance.score ?? 0) * 100);
  const audits = report.audits;
  const summary = [
    ["Score", `${score}`],
    ["FCP", auditDisplayValue(audits["first-contentful-paint"])],
    ["LCP", auditDisplayValue(audits["largest-contentful-paint"])],
    ["Speed Index", auditDisplayValue(audits["speed-index"])],
    ["TBT", auditDisplayValue(audits["total-blocking-time"])],
    ["CLS", auditDisplayValue(audits["cumulative-layout-shift"])],
  ];

  console.log("\n[lighthouse-static] Performance summary");
  console.log(`[lighthouse-static] Form factor: ${formFactor}`);
  console.log(`[lighthouse-static] Throttling: ${throttlingMethod}`);
  for (const [label, value] of summary) {
    console.log(`[lighthouse-static] ${label}: ${value}`);
  }
  console.log(`[lighthouse-static] Report: ${reportPath}`);

  if (score < threshold) {
    throw new Error(`Lighthouse performance score ${score} is below threshold ${threshold}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.url && !existsSync(OUT_DIR)) {
    throw new Error("out/ not found. Run `npm run build` before `npm run lighthouse:static`.");
  }

  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const route = normalizeRoute(options.route);
  let server = null;
  let targetUrl = options.url;

  if (!targetUrl) {
    const host = process.env.STATIC_EXPORT_HOST?.trim() || DEFAULT_HOST;
    const port = await resolveStaticExportPort(host);
    const app = createStaticExportServer({ host, port, rootDir: OUT_DIR });
    server = app.server;
    await app.listen();
    targetUrl = new URL(route, buildBaseUrl(host, port)).toString();
    await waitForReady(targetUrl);
    console.log(`[lighthouse-static] Serving static export at ${buildBaseUrl(host, port)}`);
  }

  const reportBase = path.join(outputDir, `${timestampSlug()}-${options.formFactor}-${routeSlug(route)}`);
  const lighthouseArgs = buildLighthouseArgs({
    formFactor: options.formFactor,
    reportBase,
    targetUrl,
    throttlingMethod: options.throttlingMethod,
  });

  try {
    console.log(
      `[lighthouse-static] Auditing ${targetUrl} (${options.formFactor}, threshold ${options.threshold})`,
    );
    const code = await runCommand("npx", lighthouseArgs);
    if (code !== 0) {
      throw new Error(`Lighthouse exited with code ${code}`);
    }

    const jsonPath = `${reportBase}.report.json`;
    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    printScoreSummary(report, jsonPath, options.threshold, options.throttlingMethod, options.formFactor);
  } finally {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[lighthouse-static] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
