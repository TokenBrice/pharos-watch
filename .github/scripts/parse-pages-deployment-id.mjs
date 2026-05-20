#!/usr/bin/env node
import fs from "node:fs";

const inputPath = process.argv[2] ?? "/tmp/wrangler-pages-deployments.json";

// eslint-disable-next-line security/detect-non-literal-fs-filename -- CI-trusted path from workflow context (wrangler output)
const entries = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const current = Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
const rawId = current?.Id ?? current?.id ?? current?.deployment_id ?? "";
const id = typeof rawId === "string" ? rawId : "";
if (!id && current) {
  console.warn(
    "[capture] wrangler entry lacked a recognized deployment id field; keys:",
    Object.keys(current).join(","),
  );
}
process.stdout.write(`deployment_id=${id}\n`);
