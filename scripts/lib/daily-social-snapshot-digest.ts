import { createHash } from "node:crypto";
import { DailySocialSnapshotSchema } from "@shared/lib/daily-social";

/** Sidecar suffix beside `poster.png`; binds the raster to the snapshot that produced it. */
export const DAILY_SOCIAL_SNAPSHOT_DIGEST_SUFFIX = ".snapshot.sha256";

/**
 * Digest of the canonical parsed snapshot. Build and publish parse through the
 * same schema, so the JSON key order — and therefore the digest — is stable.
 */
export function dailySocialSnapshotDigest(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(DailySocialSnapshotSchema.parse(raw))).digest("hex");
}
