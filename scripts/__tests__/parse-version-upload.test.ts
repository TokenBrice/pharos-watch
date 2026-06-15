import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function tempOutputFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pharos-version-upload-")), "wrangler-output.jsonl");
}

describe("parse-version-upload", () => {
  it("skips non-JSON Wrangler output lines while preserving version upload parsing", () => {
    const outputPath = tempOutputFile();
    writeFileSync(
      outputPath,
      [
        "wrangler progress: uploading worker",
        JSON.stringify({
          type: "version-upload",
          version_id: "version-123",
          preview_url: "https://preview.example.com",
        }),
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [".github/scripts/parse-version-upload.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WRANGLER_OUTPUT_FILE_PATH: outputPath,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("version_id=version-123");
    expect(result.stdout).toContain("preview_url=https://preview.example.com");
    expect(result.stderr).toContain("Ignoring non-JSON Wrangler output line 1");
  });
});
