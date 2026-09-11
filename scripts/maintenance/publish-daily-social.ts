import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DailySocialSnapshotSchema, DailySocialTopicSchema, buildDailySocialAltText, buildDailySocialTweetText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { DailySocialManifestSchema, dailySocialImageKey, type DailySocialManifest } from "@shared/lib/daily-social-manifest";
import { dailySocialPreparationWindow, getDailySocialEdition, DAILY_SOCIAL_MAX_SOURCE_AGE_SEC, DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC } from "@shared/lib/daily-social-schedule";
import { captureDailySocial } from "../lib/daily-social-capture";
import { parseStrictCliArgs, assertCliUsage, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PNG_MAX_BYTES = 5 * 1024 * 1024;
const HELP = `Usage: npx tsx scripts/maintenance/publish-daily-social.ts <plan|capture|publish> [options]
  --out-dir <path>   Local artifacts (default agents/daily-social/ci)
  --topic <name>     Capture-only preview of one rotation topic; cannot override publication schedule
  --dry-run         Read/validate only, with no local or remote writes
  -h, --help        Show this help

plan checks the 13:00–14:00 Europe/Belgrade preparation window and immutable KV manifest.
capture writes snapshot.json from fresh Pharos data. On unavailable topic data it tries
a clearly labelled current market overview. Render it with build-daily-social.ts.
publish verifies poster.png, writes content-addressed PNG bytes, then the dated manifest.
Nothing posts automatically: an operator tweets the prepared edition by hand.
Environment: PHAROS_API_KEY (capture; .env.local fallback), CLOUDFLARE_ACCOUNT_ID,
SAFETY_MAP_KV_TOKEN, KV_NAMESPACE_ID (plan/publish; existing SELECTOR_SNAPSHOTS namespace).`;

export interface DailySocialKv {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function makeDailySocialManifest(snapshot: DailySocialSnapshot, png: Uint8Array, nowSec: number): DailySocialManifest {
  const edition = getDailySocialEdition(nowSec);
  if (!dailySocialPreparationWindow(nowSec) || snapshot.editionDate !== edition.editionDate
    || snapshot.capturedAt > nowSec + 60 || snapshot.asOf > nowSec + 60) {
    throw new Error("Publication requires today's capture before the 14:00 Belgrade deadline");
  }
  if (png.length > PNG_MAX_BYTES || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) {
    throw new Error("Social poster must be a PNG of at most 5 MiB");
  }
  return DailySocialManifestSchema.parse({ schemaVersion: 1, snapshot, imageSha256: sha256(png),
    tweetText: buildDailySocialTweetText(snapshot), altText: buildDailySocialAltText(snapshot) });
}

export async function planDailySocial(kv: DailySocialKv, nowSec: number): Promise<{ shouldPrepare: boolean; reason: string }> {
  if (!dailySocialPreparationWindow(nowSec)) return { shouldPrepare: false, reason: "outside-preparation-window" };
  const { editionDate } = getDailySocialEdition(nowSec);
  const existing = await kv.get(`daily-social:${editionDate}.json`);
  if (!existing) return { shouldPrepare: true, reason: "edition-not-prepared" };
  const manifest = DailySocialManifestSchema.parse(JSON.parse(new TextDecoder().decode(existing)));
  if (manifest.snapshot.editionDate !== editionDate) throw new Error("Existing manifest has the wrong edition date");
  return { shouldPrepare: false, reason: "already-prepared" };
}

/** Single serialized writer. Uncommitted images use separate hashes, so safe retries need no overwrite. */
export async function publishDailySocial(kv: DailySocialKv, manifest: DailySocialManifest, png: Uint8Array, dryRun = false): Promise<string> {
  DailySocialManifestSchema.parse(manifest);
  if (sha256(png) !== manifest.imageSha256) throw new Error("Poster checksum mismatch");
  if (png.length > PNG_MAX_BYTES || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) {
    throw new Error("Invalid daily social PNG");
  }
  // Decode the full raster before the immutable commit, not just its signature.
  const { info } = await sharp(Buffer.from(png), { limitInputPixels: 1600 * 1000, failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1600 || info.height !== 1000) throw new Error("Daily social PNG must be 1600×1000");
  const key = `daily-social:${manifest.snapshot.editionDate}.json`;
  const existing = await kv.get(key);
  if (existing) {
    const previous = DailySocialManifestSchema.parse(JSON.parse(new TextDecoder().decode(existing)));
    if (previous.snapshot.editionDate !== manifest.snapshot.editionDate) throw new Error("Existing manifest has the wrong edition");
    return "already-prepared";
  }
  if (dryRun) return "would-publish";
  const imageKey = dailySocialImageKey(manifest.snapshot.editionDate, manifest.imageSha256);
  const existingImage = await kv.get(imageKey);
  if (existingImage && sha256(existingImage) !== manifest.imageSha256) throw new Error("Existing image checksum mismatch");
  if (!existingImage) await kv.put(imageKey, png);
  const readback = await kv.get(imageKey);
  if (!readback || sha256(readback) !== manifest.imageSha256) throw new Error("Image readback mismatch; manifest not published");
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  await kv.put(key, json);
  const committed = await kv.get(key);
  if (!committed || new TextDecoder().decode(committed) !== new TextDecoder().decode(json)) {
    throw new Error("Manifest readback mismatch; inspect the dated edition before retrying");
  }
  return "prepared";
}

export async function captureWithFallback(topic: DailySocialSnapshot["topic"], edition: { editionDate: string; scheduledAt: number }, nowSec: number,
  capture: typeof captureDailySocial = captureDailySocial,
): Promise<DailySocialSnapshot> {
  try {
    const candidate = DailySocialSnapshotSchema.parse(await capture(topic, edition, nowSec));
    if (dailySocialPreparationWindow(nowSec)
      && (candidate.asOf < edition.scheduledAt - DAILY_SOCIAL_MAX_SOURCE_AGE_SEC
        || candidate.capturedAt < edition.scheduledAt - DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC)) {
      throw new Error("Source will be too old at publication time");
    }
    return candidate;
  } catch (error) {
    if (topic === "market-overview") throw error;
    process.stderr.write(`Scheduled ${topic} evidence unavailable; trying a fresh market overview.\n`);
    const overview = await capture("market-overview", edition, nowSec);
    return DailySocialSnapshotSchema.parse({ ...overview, fallbackFor: topic,
      subtitle: `Current market overview; scheduled ${topic.replaceAll("-", " ")} evidence unavailable.` });
  }
}

function createKv(): DailySocialKv {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespace = process.env.KV_NAMESPACE_ID;
  const token = process.env.SAFETY_MAP_KV_TOKEN;
  if (!account || !namespace || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID and SAFETY_MAP_KV_TOKEN are required");
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{32}$/i.test(namespace)) throw new Error("Invalid Cloudflare account or namespace ID");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/`;
  return {
    async get(key) {
      const response = await fetch(base + encodeURIComponent(key), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: "error" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`KV read failed: HTTP ${response.status}`);
      return bytes;
    },
    async put(key, value) {
      const response = await fetch(base + encodeURIComponent(key), { method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(value), signal: AbortSignal.timeout(30_000), redirect: "error" });
      const result = await response.json() as { success?: boolean };
      if (!response.ok || !result.success) throw new Error(`KV write failed: HTTP ${response.status}`);
    },
  };
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseStrictCliArgs(argv, { allowPositionals: true, options: {
    "out-dir": { type: "string", default: "agents/daily-social/ci" }, topic: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  } });
  if (writeCliHelpIfRequested(values, HELP)) return;
  const mode = positionals[0];
  assertCliUsage(positionals.length === 1 && ["plan", "capture", "publish"].includes(mode), "Choose plan, capture or publish");
  assertCliUsage(values.topic == null || mode === "capture", "--topic is available for capture previews only");
  const outDir = resolve(String(values["out-dir"]));
  const now = Math.floor(Date.now() / 1000);
  const edition = getDailySocialEdition(now);
  if (mode === "plan") {
    // The timezone-only no-op also works before credentials are provisioned.
    const result = dailySocialPreparationWindow(now)
      ? await planDailySocial(createKv(), now)
      : { shouldPrepare: false, reason: "outside-preparation-window" };
    if (!values["dry-run"] && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `should_prepare=${result.shouldPrepare}\n`);
    process.stdout.write(`${edition.editionDate}: ${result.reason}\n`);
    return;
  }
  if (mode === "capture") {
    const topic = DailySocialTopicSchema.parse(values.topic ?? edition.topic);
    if (!process.env.PHAROS_API_KEY && existsSync(resolve(ROOT, ".env.local"))) process.loadEnvFile(resolve(ROOT, ".env.local"));
    const snapshot = await captureWithFallback(topic, edition, now);
    if (!values["dry-run"]) { mkdirSync(outDir, { recursive: true }); writeFileSync(resolve(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n"); }
    process.stdout.write(buildDailySocialTweetText(snapshot) + "\n");
    return;
  }
  const snapshot = DailySocialSnapshotSchema.parse(JSON.parse(readFileSync(resolve(outDir, "snapshot.json"), "utf8")));
  const png = readFileSync(resolve(outDir, "poster.png"));
  const manifest = makeDailySocialManifest(snapshot, png, now);
  const status = await publishDailySocial(createKv(), manifest, png, Boolean(values["dry-run"]));
  if (!values["dry-run"]) writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`${status}: ${manifest.snapshot.editionDate}\n`);
}

if (isDirectRun(import.meta.url, process.argv[1])) void runCliEntrypoint(() => main(process.argv.slice(2)), { label: "daily-social", usage: HELP });
