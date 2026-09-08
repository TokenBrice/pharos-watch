import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve("scripts/maintenance/weekly-curation-digest.mjs");

export function renderDigest({
  coins = [], summaries = {}, queue,
}: {
  coins?: Record<string, unknown>[];
  summaries?: Record<string, unknown>;
  queue?: string;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "curation-digest-"));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    put("shared/data/stablecoins/coins.generated.json", JSON.stringify(coins));
    put("data/ai-summaries.json", JSON.stringify(summaries));
    put("scripts/lib/curation-baseline-caps.json", JSON.stringify({ segmentLabel: "fixture", topByRank: [] }));
    if (queue !== undefined) put("agents/annotation-candidates.md", queue);
    put("clock.mjs", `const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ["2026-07-01T00:00:00.000Z"])); }
        static now() { return NativeDate.parse("2026-07-01T00:00:00.000Z"); }
      };`);
    return execFileSync(process.execPath, ["--import", join(root, "clock.mjs"), script], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
