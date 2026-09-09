import { z } from "zod";
import { DailySocialSnapshotSchema, buildDailySocialAltText, buildDailySocialTweetText } from "./daily-social";
import {
  dailySocialScheduledAt, getDailySocialEdition,
  DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC, DAILY_SOCIAL_MAX_SOURCE_AGE_SEC,
} from "./daily-social-schedule";

export const DailySocialManifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: DailySocialSnapshotSchema,
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tweetText: z.string().min(1).max(280),
  altText: z.string().min(1).max(1000),
}).strict().superRefine((manifest, ctx) => {
  const { snapshot } = manifest;
  const scheduledAt = dailySocialScheduledAt(snapshot.editionDate);
  const expected = getDailySocialEdition(scheduledAt);
  const expectedTopic = snapshot.fallbackFor ?? snapshot.topic;
  if (snapshot.scheduledAt !== scheduledAt || expectedTopic !== expected.topic
    || (snapshot.fallbackFor != null && (snapshot.topic !== "market-overview" || snapshot.fallbackFor === "market-overview"))
    || snapshot.capturedAt >= scheduledAt
    || snapshot.capturedAt < scheduledAt - DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC
    || snapshot.asOf < scheduledAt - DAILY_SOCIAL_MAX_SOURCE_AGE_SEC
    || manifest.tweetText !== buildDailySocialTweetText(snapshot)
    || manifest.altText !== buildDailySocialAltText(snapshot)) {
    ctx.addIssue({ code: "custom", message: "Daily social manifest contradicts the edition, provenance, or authored text" });
  }
});

export type DailySocialManifest = z.infer<typeof DailySocialManifestSchema>;

export function dailySocialImageKey(editionDate: string, sha256: string): string {
  return `daily-social:${editionDate}:${sha256}.png`;
}
