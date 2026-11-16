import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Shared imports must not pull an executable CLI's top-level await into tsx/CJS.
export function loadCloudflareAccountStateManifest(path = resolve(process.cwd(), "scripts/ci/cloudflare-account-state-manifest.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}
