import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(".env.local");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

await import("./dev-api-proxy.mjs");
