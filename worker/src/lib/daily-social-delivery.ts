import { bufferReadableStream } from "@shared/lib/bounded-stream";
import { DailySocialManifestSchema } from "@shared/lib/daily-social-manifest";
import { buildDailySocialTweetText, buildDailySocialAltText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { getDailySocialEdition, isDailySocialDeliveryDue, DAILY_SOCIAL_MAX_SOURCE_AGE_SEC, DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC } from "@shared/lib/daily-social-schedule";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { getCache } from "./db-cache";
import { deliverTwitterDigestWithLedger, terminalTwitterDigestResult } from "./twitter-digest-ledger";
import { postImageTweet, TwitterPostError, type TwitterCreds } from "./twitter";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function fetchArtifact(path: string, maxBytes: number, contentType: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetch(`${SITE_ORIGIN}/social-posts/${path}`, { signal: requestSignal, redirect: "error" });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim() !== contentType || !response.body) {
    await response.body?.cancel();
    throw new Error(`Daily social artifact unavailable or invalid (${response.status})`);
  }
  return (await bufferReadableStream(response.body, { maxBytes, signal: requestSignal })).bytes;
}

function validSnapshotAt(snapshot: DailySocialSnapshot, nowSec: number): boolean {
  const edition = getDailySocialEdition(nowSec);
  return isDailySocialDeliveryDue(nowSec)
    && snapshot.editionDate === edition.editionDate
    && (snapshot.fallbackFor ?? snapshot.topic) === edition.topic
    && snapshot.scheduledAt === edition.scheduledAt
    && snapshot.capturedAt < snapshot.scheduledAt
    && snapshot.capturedAt <= nowSec
    && nowSec - snapshot.capturedAt <= DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC
    && snapshot.asOf <= snapshot.capturedAt + 60
    && nowSec - snapshot.asOf <= DAILY_SOCIAL_MAX_SOURCE_AGE_SEC;
}

export async function deliverDailySocial(
  db: D1Database,
  creds: TwitterCreds,
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ status: string; reason?: string; tweetId?: string }> {
  const wallNow = Math.floor(Date.now() / 1000);
  const { editionDate } = getDailySocialEdition(nowSec);
  if (!isDailySocialDeliveryDue(nowSec) || !isDailySocialDeliveryDue(wallNow)
    || getDailySocialEdition(wallNow).editionDate !== editionDate) {
    return { status: "skipped", reason: "outside-publication-window" };
  }
  const ledgerKey = `daily-social:twitter-sent:${editionDate}`;
  const existing = await getCache(db, ledgerKey, signal);
  if (existing) {
    const terminal = terminalTwitterDigestResult(existing.value);
    if (terminal?.status === "skipped") return terminal;
  }
  const json = await fetchArtifact(`${editionDate}.json`, 32_768, "application/json", signal);
  if (!json) return { status: "skipped", reason: "awaiting-artifact" };
  const manifest = DailySocialManifestSchema.parse(JSON.parse(new TextDecoder().decode(json)));
  if (!validSnapshotAt(manifest.snapshot, nowSec) || !validSnapshotAt(manifest.snapshot, wallNow)) {
    throw new Error("Daily social artifact is stale or has the wrong edition");
  }
  if (manifest.tweetText !== buildDailySocialTweetText(manifest.snapshot)
    || manifest.altText !== buildDailySocialAltText(manifest.snapshot)) {
    throw new Error("Daily social copy does not match its snapshot");
  }
  const png = await fetchArtifact(`${editionDate}.png`, MAX_IMAGE_BYTES, "image/png", signal);
  if (!png) return { status: "skipped", reason: "awaiting-image" };
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => png[index] === byte)) {
    throw new Error("Daily social image is not a PNG");
  }
  const digest = await crypto.subtle.digest("SHA-256", png);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== manifest.imageSha256) throw new Error("Daily social image digest mismatch");
  const result = await deliverTwitterDigestWithLedger(
    db, ledgerKey, null, nowSec,
    () => {
      const assertPublicationWindow = () => {
        if (!validSnapshotAt(manifest.snapshot, Math.floor(Date.now() / 1000))) {
          throw new TwitterPostError("Daily social publication window elapsed before tweet preparation", "definitive_failure");
        }
      };
      assertPublicationWindow();
      return postImageTweet(manifest.tweetText, png.buffer, manifest.altText, creds, signal, assertPublicationWindow);
    },
    signal,
  );
  return result.status === "sent" ? { status: "sent", tweetId: result.post.tweetId } : result;
}
