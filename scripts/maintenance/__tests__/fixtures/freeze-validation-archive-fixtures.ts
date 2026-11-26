import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  SAFETY_SCORE_V9_CACHE_KEYS as V9_KEYS,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY as V9_BASE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY as V9_DELTA_KEY,
} from "@shared/types/safety-score-cache-keys";
import { R2ObjectExistsError } from "../../../lib/r2-object-client";
import {
  GLOBAL_MARKET_SPECS, runFreezeValidationArchiveCli, sha256Hex,
  type FreezeValidationArchiveDeps, type ValidationArchiveR2Client,
} from "../../freeze-validation-archive";

export const PREFIX = "pinned/validation/";
export const DAY = "2026-12-31";
export const NOW = new Date(`${DAY}T10:00:00Z`);
export const EMPTY_SPECS = [11, 6].map((i) => GLOBAL_MARKET_SPECS[i]!);
export const MATRIX_SPECS = [
  ...[11, 12, 13, 14, 15, 16].map((i) => GLOBAL_MARKET_SPECS[i]!),
  { ...GLOBAL_MARKET_SPECS[16]!, pair: "PYUSD-USD" },
  GLOBAL_MARKET_SPECS[6]!,
  GLOBAL_MARKET_SPECS[7]!,
];

export const EXPECTED_MATRIX_LISTED = [
  [true, null],
  [null, "coinbase-trading-disabled"],
  [null, "coinbase-product-offline"],
  [null, "coinbase-product-status-unknown"],
  [null, "coinbase-malformed-top-of-book"],
  [false, "coinbase-product-delisted"],
  [null, "coinbase-product-internal"],
  [null, "kraken-catalog-depth-contradiction"],
  [false, "kraken-pair-not-in-catalog"],
] as const;

const HASH64 = "a".repeat(64);
const DESIGN_DOC = readFileSync("docs/process/pre-cliff-baseline.md");
const V9_ID = {
  model: "v9", schemaVersion: 1, methodologyVersion: "10.57", policyId: "v9-v1",
  policyDigest: HASH64, evaluationBuildDigest: HASH64,
  baseInputGenerationId: `report-cards-input:v1:${HASH64}`, publicationGenerationId: "v9-pub-1",
};

export const readJson = <T,>(store: Map<string, Buffer>, key: string, gz = false): T =>
  JSON.parse((gz ? gunzipSync(store.get(key)!) : store.get(key)!).toString("utf8")) as T;

export const jsonFetch = (body: (url: string) => unknown, status?: (url: string) => number, onInit?: (init?: RequestInit) => void): typeof fetch =>
  (async (input: unknown, initArg?: RequestInit) => {
    onInit?.(initArg);
    const url = String(input), val = body(url), init = { status: status?.(url) ?? 200 };
    return typeof val === "string" ? new Response(val, init) : Response.json(val, init);
  }) as typeof fetch;

export const validFetch = (overrides: { omitStudyFields?: boolean; onInit?: (init?: RequestInit) => void } = {}): typeof fetch => jsonFetch((u) => {
  const snap = /snapshots\/(\d{4}-\d{2}-\d{2})\.json$/.exec(u);
  if (snap) return { snapshotDate: snap[1], generatedAt: 1_798_704_000, stablecoins: [{ id: "usdc-circle", circulating: { peggedUSD: 1e9 } }] };
  if (u.endsWith("/peg-summary")) {
    return {
      coins: [{ id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", ...(overrides.omitStudyFields ? {} : { currentDeviationBps: 1.5 }) }],
      summary: { totalTracked: 1 },
    };
  }
  if (u.endsWith("/dex-liquidity")) {
    return {
      "usdc-circle": {
        totalTvlUsd: 1e6, effectiveTvlUsd: 1e6, ...(overrides.omitStudyFields ? {} : { totalVolume24hUsd: 2e5 }),
        poolCount: 2, updatedAt: 1_798_704_000, methodologyVersion: "1.0",
      },
    };
  }
  if (u.endsWith("/report-cards/v9")) {
    return {
      model: "v9", safetyScoreIdentity: V9_ID,
      cards: [
        { id: "usdc-circle", ratingStatus: "rated", grade: "A-", score: 88 },
        { id: "usde-ethena", ratingStatus: "pipeline-gap", grade: null, score: null },
      ],
    };
  }
  return /stablr|esma|kraken\.com\/articles|coinbase\.com\/en-gb/.test(u) ? "notice" : {};
}, undefined, overrides.onInit);

export const emptyFetch = (): typeof fetch => jsonFetch((u) => (u.endsWith("products") ? [] : { error: [], result: {} }));

export const malformedCatalogFetch = (): typeof fetch => jsonFetch((u) =>
  u.endsWith("products") ? [{ id: "OTHER-USD", status: "online" }, { broken: true }] : { error: [], result: { DAIUSD: null } },
);

export const cexFetch = (): typeof fetch => jsonFetch((u) =>
  u.endsWith("products") ? [
    { id: "USDC-EUR", status: "online" }, { id: "USDT-USD", status: "online", trading_disabled: true },
    { id: "USDT-EUR", status: "offline" }, { id: "EURC-USDC" }, { id: "USDS-USD", status: "online" },
    { id: "PAX-USD", status: "delisted" }, { id: "PYUSD-USD", status: "internal" },
  ] : u.includes("AssetPairs") ? { error: [], result: { DAIUSD: { status: "online" }, XUSDZ: { status: "online" } } }
    : u.includes("Ticker") ? { error: [], result: { Z: { a: ["1.1"], b: ["1.1"] } } }
    : u.includes("USDC-EUR/book") ? { bids: [["1", "10"], [".98", "1"]], asks: [["1", "5"], ["1.02", "1"]] }
    : u.includes("USDS-USD/book") ? { bids: [[true, "10"]], asks: [["1", "5"]] }
    : { error: ["EQuery:Unknown asset pair"] },
);

export function createEnv(overrides: Partial<FreezeValidationArchiveDeps> = {}, failManifestOnce = false) {
  const store = new Map<string, Buffer>(), puts: string[] = [];
  let failOnce = failManifestOnce, stdout = "";
  const r2: ValidationArchiveR2Client = {
    async put(key, data, opts) {
      puts.push(opts?.ifNoneMatch ?? "");
      if (failOnce && key.includes("/manifests/")) { failOnce = false; throw new Error("manifest-put-interrupted"); }
      if (opts?.ifNoneMatch === "*" && store.has(key)) throw new R2ObjectExistsError(key);
      store.set(key, Buffer.from(data));
    },
    get: async (key) => store.get(key) ?? null,
    head: async (key) => {
      const buf = store.get(key);
      return buf ? { etag: null, contentLength: buf.byteLength, contentType: null, customMetadata: {} } : null;
    },
    list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
  };
  const run = (...argv: string[]) => {
    stdout = "";
    return runFreezeValidationArchiveCli(argv, {
      r2, fetch: jsonFetch(() => ({}), () => 500), now: () => NOW, gitSha: () => "c4ec79a",
      checkDirtySealPaths: () => [], readDesignDocAtGitRef: () => DESIGN_DOC,
      stdout: { write: (s) => { stdout += s; } }, ...overrides,
    });
  };
  return {
    r2, store, puts, run,
    seal: (date = DAY, ...extra: string[]) => run("baseline", "--date", date, "--seal", ...extra),
    verify: (key: string, ...extra: string[]) => run("verify", "--manifest", key, ...extra),
    roll: (day: string, ...extra: string[]) => run("roll", "--date", day, ...extra),
    jsonOut: () => JSON.parse(stdout) as Record<string, unknown>,
    rawOut: () => stdout,
  };
}

export function createRollEnv(day: string, nowIso: string) {
  const pubSec = Date.parse(`${day}T04:00:00Z`) / 1_000;
  const capBody = Buffer.from(JSON.stringify({
    schemaVersion: 1, generationId: "g1", publishedAt: pubSec, methodologyVersion: "10.57", policyDigest: HASH64, evaluationBuildDigest: HASH64,
    base: { key: V9_BASE_KEY, value: "{}", updatedAt: pubSec }, delta: { key: V9_DELTA_KEY, value: "{}", updatedAt: pubSec }, cards: { key: V9_KEYS.publication, value: "{}", updatedAt: pubSec },
  }));
  const capRow = {
    _rowid: 1, generation_id: "g1", published_at: pubSec, methodology_version: "10.57", policy_digest: HASH64,
    evaluation_build_digest: HASH64, r2_key: `captures/safety-score-v9-accepted/${day}/g1.json`,
    object_sha256: sha256Hex(capBody), object_bytes: capBody.byteLength,
  };
  let qty = "10", currentNow = new Date(nowIso);
  const book = () => ({ bids: [["1", qty], [".98", "1"]], asks: [["1", "5"], ["1.02", "1"]] });
  const env = createEnv({
    now: () => currentNow,
    d1: { queryRaw: (sql) => JSON.stringify([{ success: true, results: sql.includes("capture") ? [capRow] : [] }]) },
    fetch: jsonFetch((u) =>
      u.endsWith("products") ? [{ id: "USDC-EUR", status: "online" }]
        : u.includes("AssetPairs") ? { error: [], result: { USDCUSD: { status: "online" } } }
        : u.includes("Ticker") ? { error: [], result: { Z: { a: ["1.1"], b: ["1.1"] } } }
        : u.includes("/book") ? book() : u.includes("/Depth") ? { error: [], result: { USDCUSD: book() } } : "notice"),
  }, true);
  env.store.set(capRow.r2_key, capBody);
  return { env, setBookQty: (next: string) => { qty = next; }, setNow: (iso: string) => { currentNow = new Date(iso); } };
}
