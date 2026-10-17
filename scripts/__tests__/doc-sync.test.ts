import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDocSyncChecks } from "../lib/doc-sync/checks";
import {
  ISOLATE_LOCAL_STATE_DOC_END,
  ISOLATE_LOCAL_STATE_DOC_START,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";

const ROOT = resolve(import.meta.dirname, "../..");
const RUNTIME_DOC = "docs/worker-infrastructure.md";
const ISOLATE_DOC = "docs/process/worker-infrastructure-appendix.md";
const runtimeDoc = readFileSync(resolve(ROOT, RUNTIME_DOC), "utf8");
const publicToml = readFileSync(resolve(ROOT, "worker/wrangler.toml"), "utf8");

function checkWithOverrides(overrides: Record<string, string>) {
  return runDocSyncChecks((file) => overrides[file] ?? readFileSync(resolve(ROOT, file), "utf8"));
}

describe("doc-sync Worker runtime documentation", () => {
  it("accepts the source-owned runtime snippet", () => {
    expect(checkWithOverrides({})).toEqual([]);
  });

  it.each([
    ["compatibility_date", '"wrong-date"'],
    ["compatibility_flags", "[]"],
    ["preview_urls", "false"],
    ["minify", "false"],
    ["keep_names", "false"],
    ['"#pharos-full-catalog"', '"./wrong-catalog.ts"'],
    ["cpu_ms", "1"],
    ["enabled", "false"],
    ["head_sampling_rate", "1"],
    ["invocation_logs", "false"],
  ])("rejects documented runtime drift in %s", (key, value) => {
    const failures = checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace(new RegExp(`^${key}\\s*=.*$`, "gm"), `${key} = ${value}`),
    });
    expect(failures.some((failure) => failure.file === RUNTIME_DOC && failure.label.startsWith("runtime configuration "))).toBe(true);
  });

  it("checks both observability enabled assignments independently", () => {
    const failures = checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace("[observability.logs]\nenabled = true", "[observability.logs]\nenabled = false"),
    });
    expect(failures).toEqual([
      { file: RUNTIME_DOC, label: "runtime configuration observability.logs.enabled", expected: "true", found: "false" },
    ]);
  });

  it("rejects a missing runtime field in either the docs or the source", () => {
    for (const file of [RUNTIME_DOC, "worker/wrangler.toml"]) {
      const text = file === RUNTIME_DOC ? runtimeDoc : publicToml;
      expect(checkWithOverrides({ [file]: text.replace(/^keep_names\s*=.*\n/m, "") })).toEqual([
        {
          file,
          label: "runtime configuration root.keep_names",
          expected: file === RUNTIME_DOC ? "true" : "declared",
          found: null,
        },
      ]);
    }
  });

  it.each([
    runtimeDoc.replace("## Runtime Limits and Observability", "## Other Runtime Notes"),
    runtimeDoc.replace("```toml", "```text"),
    "## Runtime Limits and Observability\nNo snippet.\n## Another Section\n```toml\nminify = true\n```",
  ])("rejects a missing TOML snippet in the owning section", (document) => {
    expect(checkWithOverrides({ [RUNTIME_DOC]: document })).toEqual([
      { file: RUNTIME_DOC, label: "runtime limits snippet", expected: "toml runtime limits snippet", found: null },
    ]);
  });

  it("ignores comments and insignificant assignment whitespace", () => {
    expect(checkWithOverrides({
      [RUNTIME_DOC]: runtimeDoc.replace("minify = true", "minify   =   true # documented setting"),
    })).toEqual([]);
  });
});

describe("doc-sync isolate-local state documentation", () => {
  it.each([
    "",
    `${ISOLATE_LOCAL_STATE_DOC_START}stale${ISOLATE_LOCAL_STATE_DOC_END}`,
    `${renderIsolateLocalStateDocumentation()}${ISOLATE_LOCAL_STATE_DOC_START}`,
    `${renderIsolateLocalStateDocumentation()}${ISOLATE_LOCAL_STATE_DOC_END}`,
  ])("rejects missing, stale or duplicate registry regions", (document) => {
    const failures = checkWithOverrides({ [ISOLATE_DOC]: document });
    expect(failures).toEqual([
      expect.objectContaining({
        file: ISOLATE_DOC,
        label: "isolate-local state registry",
        expected: renderIsolateLocalStateDocumentation(),
      }),
    ]);
  });
});
