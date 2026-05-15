#!/usr/bin/env node
import fs from "node:fs";

const outputPath = process.env.WRANGLER_OUTPUT_FILE_PATH ?? "/tmp/wrangler-output.jsonl";

const entries = fs
  .readFileSync(outputPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const uploadEvent = [...entries].reverse().find((entry) => entry.type === "version-upload");
if (!uploadEvent?.version_id) {
  throw new Error("Missing version-upload event in Wrangler output");
}
if (!uploadEvent?.preview_url) {
  throw new Error("Missing preview URL in Wrangler version-upload output");
}
process.stdout.write(`version_id=${uploadEvent.version_id}\n`);
process.stdout.write(`preview_url=${uploadEvent.preview_url}\n`);
