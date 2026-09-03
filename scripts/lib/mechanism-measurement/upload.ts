import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, relative, resolve } from "node:path";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../cli-args.mjs";
import { createR2MeasurementsClient } from "../r2-measurements-client";
import {
  MECHANISM_MEASUREMENT_ROOT,
  buildMechanismCaptureSummary,
  summaryPathForCapture,
} from "./capture-summary";

async function collectJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".summary.json")) files.push(path);
  }
  return files.sort();
}

function loadPinnedCaptureRefs(): Map<string, string> {
  const value: unknown = SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST;
  if (!value || typeof value !== "object" || !("captures" in value) || !Array.isArray(value.captures)) {
    return new Map();
  }
  const refs = value.captures.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("sha256" in candidate) || !("r2Key" in candidate)) return [];
    if (typeof candidate.sha256 !== "string" || typeof candidate.r2Key !== "string") return [];
    return [{ sha256: candidate.sha256, r2Key: candidate.r2Key }];
  });
  return new Map(refs.map((capture) => [capture.sha256, capture.r2Key]));
}

interface PreparedCapture {
  absolutePath: string;
  relativePath: string;
  raw: Buffer;
  compressed: Buffer;
  summary: ReturnType<typeof buildMechanismCaptureSummary>;
}

async function prepareCaptures(root: string): Promise<PreparedCapture[]> {
  const measurementRoot = resolve(root, MECHANISM_MEASUREMENT_ROOT);
  const files = await collectJsonFiles(measurementRoot);
  return Promise.all(
    files.map(async (absolutePath) => {
      const raw = await readFile(absolutePath);
      const relativePath = relative(root, absolutePath).split("\\").join("/");
      return {
        absolutePath,
        relativePath,
        raw,
        compressed: gzipSync(raw),
        summary: buildMechanismCaptureSummary(raw, relativePath, root, relativePath.split("/").at(-2)),
      };
    }),
  );
}

const USAGE = `Usage: node --import tsx scripts/lib/mechanism-measurement/upload.ts [options]

Uploads mechanism measurement bodies to R2, writes their compact git summaries,
and removes the uploaded raw bodies from the working tree. The --smoke mode
writes one tiny object and verifies it through HEAD and GET without touching the
measurement corpus.

Options:
  --smoke       Upload captures/_smoke/<timestamp>.json and verify HEAD/GET
  --root <dir>  Repository root (default: current working directory)
  --keep        Upload and summarize without removing raw bodies
  -h, --help    Show this help`;


async function smoke(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  const key = `captures/_smoke/${timestamp}.json`;
  const body = Buffer.from(JSON.stringify({ smoke: true, timestamp }));
  const client = createR2MeasurementsClient();
  await client.put(key, body, { contentType: "application/json" });
  const metadata = await client.head(key);
  if (!metadata || metadata.contentLength !== body.byteLength) {
    throw new Error(`R2 smoke HEAD mismatch for ${key}: expected ${body.byteLength} bytes`);
  }
  const readback = await client.get(key);
  if (!readback || !readback.equals(body)) throw new Error(`R2 smoke GET mismatch for ${key}`);
  process.stdout.write(`R2 smoke upload/readback succeeded: ${key} (${body.byteLength} bytes)\n`);
}
function blockTimestamp(value: unknown): number {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "timestampUnix" in value &&
    typeof value.timestampUnix === "number"
  ) {
    return value.timestampUnix;
  }
  return -1;
}

export async function uploadMechanismMeasurements(
  root: string,
  removeBodies = true,
): Promise<{ uploaded: number; pinned: number; bytes: number; pinnedKeys: string[] }> {
  const captures = await prepareCaptures(root);
  const pinnedRefs = loadPinnedCaptureRefs();
  const latestShockByAsset = new Map<string, PreparedCapture>();
  for (const capture of captures) {
    if (capture.summary.summary.kind !== "cdp-shock-coverage-measurement") continue;
    const previous = latestShockByAsset.get(capture.summary.mechanism);
    const previousTimestamp = blockTimestamp(previous?.summary.summary.block);
    const currentTimestamp = blockTimestamp(capture.summary.summary.block);
    if (!previous || currentTimestamp > previousTimestamp) latestShockByAsset.set(capture.summary.mechanism, capture);
  }
  for (const capture of latestShockByAsset.values()) pinnedRefs.set(capture.summary.sha256, capture.summary.r2Key);

  const client = createR2MeasurementsClient();
  let uploaded = 0;
  let pinned = 0;
  let bytes = 0;
  const pinnedKeys: string[] = [];
  for (const capture of captures) {
    await client.put(capture.summary.r2Key, capture.compressed, {
      contentType: "application/json",
      contentEncoding: "gzip",
    });
    const pinnedKey = pinnedRefs.get(capture.summary.sha256);
    if (pinnedKey) {
      const objectKey = pinnedKey.replace(/^captures\//u, "pinned/");
      await client.put(objectKey, capture.compressed, {
        contentType: "application/json",
        contentEncoding: "gzip",
      });
      pinnedKeys.push(objectKey);
      pinned += 1;
    }
    await mkdir(dirname(resolve(root, summaryPathForCapture(capture.relativePath))), { recursive: true });
    await writeFile(
      resolve(root, summaryPathForCapture(capture.relativePath)),
      `${JSON.stringify(capture.summary, null, 2)}\n`,
      "utf8",
    );
    if (removeBodies) await rm(capture.absolutePath);
    uploaded += 1;
    bytes += capture.raw.byteLength;
  }
  process.stdout.write(`Uploaded ${uploaded} measurement capture(s) (${bytes} bytes), pinned ${pinned}.\n`);
  if (pinnedKeys.length > 0) process.stdout.write(`Pinned keys:\n${pinnedKeys.join("\n")}\n`);
  return { uploaded, pinned, bytes, pinnedKeys };
}

export async function runMechanismMeasurementUploadCli(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      smoke: { type: "boolean" },
      root: { type: "string" },
      keep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const root = resolve(typeof values.root === "string" ? values.root : process.cwd());
  if (values.smoke === true) return smoke();
  await uploadMechanismMeasurements(root, values.keep !== true);
}

runDirectCli(import.meta.url, () => runMechanismMeasurementUploadCli(), {
  label: "upload-mechanism-measurements",
  usage: USAGE,
});
