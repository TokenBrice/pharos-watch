import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { toErrorMessage } from "./error-utils";
import { readResponseTextBoundedWithSignal } from "./response-body";

const MANIFEST_URL = `${SITE_ORIGIN}/safety-scores/map.json`;
const IMAGE_PATH = "/safety-scores/map.png";
const READ_TIMEOUT_MS = 3_000;
const MANIFEST_MAX_BYTES = 16_384;
const MAX_DATA_AGE_SEC = 24 * 60 * 60;

interface SafetyMapManifest {
  date: string;
  asOfSec: number;
  renderedAtSec: number;
  edition: "daily";
  bytes: { png: number };
}

export type DigestSafetyMapResolution =
  | { kind: "available"; imageUrl: string; manifest: SafetyMapManifest }
  | { kind: "unavailable"; reason: string };

function parseManifest(value: unknown): SafetyMapManifest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SafetyMapManifest>;
  if (
    typeof candidate.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)
    || !Number.isFinite(candidate.asOfSec)
    || !Number.isFinite(candidate.renderedAtSec)
    || candidate.edition !== "daily"
    || !candidate.bytes
    || !Number.isFinite(candidate.bytes.png)
    || candidate.bytes.png <= 0
  ) {
    return null;
  }
  return candidate as SafetyMapManifest;
}

export async function resolveDigestSafetyMap(
  date: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DigestSafetyMapResolution> {
  const timeoutSignal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const manifestResponse = await fetch(MANIFEST_URL, {
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    if (!manifestResponse.ok) {
      await manifestResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: `manifest-http-${manifestResponse.status}` };
    }
    const raw = await readResponseTextBoundedWithSignal(
      manifestResponse,
      MANIFEST_MAX_BYTES,
      requestSignal,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return { kind: "unavailable", reason: "manifest-invalid-json" };
    }
    const manifest = parseManifest(decoded);
    if (!manifest) return { kind: "unavailable", reason: "manifest-invalid" };
    if (manifest.date !== date) return { kind: "unavailable", reason: "manifest-not-today" };
    const ageSec = nowSec - manifest.asOfSec;
    if (ageSec < 0 || ageSec >= MAX_DATA_AGE_SEC) {
      return { kind: "unavailable", reason: "manifest-data-stale" };
    }

    const imageUrl = `${SITE_ORIGIN}${IMAGE_PATH}?date=${encodeURIComponent(date)}`;
    const imageResponse = await fetch(imageUrl, { method: "HEAD", signal: requestSignal });
    if (!imageResponse.ok) {
      await imageResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: `image-http-${imageResponse.status}` };
    }
    const contentType = imageResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/png")) {
      await imageResponse.body?.cancel().catch(() => undefined);
      return { kind: "unavailable", reason: "image-content-type" };
    }
    await imageResponse.body?.cancel().catch(() => undefined);
    return { kind: "available", imageUrl, manifest };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unavailable", reason: `read-failed:${toErrorMessage(error).slice(0, 80)}` };
  }
}
