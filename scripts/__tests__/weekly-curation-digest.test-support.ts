import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const script = resolve("scripts/maintenance/weekly-curation-digest.mjs");
const scriptUrl = pathToFileURL(script).href;
const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const tsconfigPath = resolve("tsconfig.json");

export interface DatedReviewExpiryItem {
  id: string;
  expiryDate: string;
  expiryMs: number;
  expired: boolean;
  invalid: boolean;
  daysDelta: number | null;
}

export interface DatedReviewExpiryReport {
  lookaheadDays: number;
  horizonDate: string;
  totalRegistries: number;
  totalEntries: number;
  totalExpired: number;
  totalInvalid: number;
  groups: { registry: string; items: DatedReviewExpiryItem[] }[];
}

export interface WeeklyCurationDigestModule {
  EXPIRY_LOOKAHEAD_DAYS: number;
  analyzeDatedReviewExpiries: (
    registries: readonly { registry: string; entries: readonly { id: string; expiresAt: string | number | null | undefined }[] }[],
    nowMs?: number,
    lookaheadDays?: number,
  ) => DatedReviewExpiryReport;
  buildDatedReviewRegistries: (
    horizonMs: number,
  ) => readonly { registry: string; entries: readonly { id: string; expiresAt: string | number | null | undefined }[] }[];
  collectDatedReviewExpiries: (nowMs?: number, lookaheadDays?: number) => DatedReviewExpiryReport;
  renderDatedReviewExpiries: (report: DatedReviewExpiryReport) => string;
}

export async function loadDigestModule(): Promise<WeeklyCurationDigestModule> {
  return import(scriptUrl) as Promise<WeeklyCurationDigestModule>;
}

export function renderDigest({
  coins = [], summaries = {}, queue, nowIso = "2026-07-01T00:00:00.000Z",
}: {
  coins?: Record<string, unknown>[];
  summaries?: Record<string, unknown>;
  queue?: string;
  nowIso?: string;
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
        constructor(...args) { super(...(args.length ? args : [${JSON.stringify(nowIso)}])); }
        static now() { return NativeDate.parse(${JSON.stringify(nowIso)}); }
      };`);
    return execFileSync(process.execPath, ["--import", tsxLoader, "--import", join(root, "clock.mjs"), script], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
