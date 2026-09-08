import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { R2MeasurementsClient } from "../lib/r2-measurements-client";

const captureRoots: string[] = [];

export function cleanupCaptures() {
  for (const root of captureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function captureFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pharos-cdp-capture-"));
  captureRoots.push(directory);
  const bodyPath = join(directory, "capture.json");
  const cacheDir = join(directory, "cache");
  const body = Buffer.from("opaque capture bytes\n");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const r2Key = "captures/test/2026-09-03.json.gz";
  const cachePath = join(cacheDir, sha256 + ".json");
  writeFileSync(join(directory, "capture.summary.json"), JSON.stringify({
    mechanism: "test", date: "2026-09-03", sha256, bytes: body.byteLength, r2Key,
    summary: { kind: "cdp-mechanism-measurement", assetId: "test", journalPath: bodyPath },
  }));
  mkdirSync(cacheDir);
  return { bodyPath, cacheDir, cachePath, body, r2Key, sha256 };
}

export function remote(get: R2MeasurementsClient["get"]): R2MeasurementsClient {
  return {
    get,
    put: async () => { throw new Error("unexpected remote write"); },
    head: async () => { throw new Error("unexpected remote metadata read"); },
  };
}
