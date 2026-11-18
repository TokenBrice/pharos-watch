import { SocialScorecardMetadataSchema, SocialScorecardRecordSchema, type SocialScorecardMetadata, type SocialScorecardRecord } from "../types/social-scorecard";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { sha256Hex, sha256HexFromBytes } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH } from "./social-preview";

export const SOCIAL_SCORECARD_METADATA_HEADER = "X-Pharos-Scorecard";
export const SOCIAL_SCORECARD_RENDERER_REVISION = "scorecard-5";
export const SOCIAL_SCORECARD_OVERVIEW_ID = "safety-scores";
/** Why a coin has no dated scorecard: it has no published grade. Worker route and Pages creator answer it alike. */
export const SOCIAL_SCORECARD_REASON_HEADER = "X-Scorecard-Reason";
export const SOCIAL_SCORECARD_NOT_RATED_REASON = "not-rated";
export const SOCIAL_SCORECARD_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SOCIAL_SCORECARD_MAX_RECORD_BYTES = 2_810_000;
const SOCIAL_SCORECARD_MAX_HEADER_BYTES = 4096;

export function isSocialScorecardId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function socialScorecardPaths(id: string): { url: string; imageUrl: string } {
  if (!isSocialScorecardId(id)) throw new Error("Invalid scorecard content identity");
  return { url: `/share/scorecard/${id}/`, imageUrl: `/share/scorecard/${id}.png` };
}

export function socialScorecardLivePath(metadata: SocialScorecardMetadata): string {
  return metadata.subject.kind === "overview" ? "/safety-scores/" : `/stablecoin/${metadata.subject.id}/`;
}

export function encodeSocialScorecardMetadata(metadata: SocialScorecardMetadata): string {
  // HTTP headers are ASCII even when the trusted catalog subject contains Unicode.
  const encoded = JSON.stringify(SocialScorecardMetadataSchema.parse(metadata))
    .replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (encoded.length > SOCIAL_SCORECARD_MAX_HEADER_BYTES) throw new Error("Scorecard metadata too large");
  return encoded;
}

export function decodeSocialScorecardMetadata(header: string | null): SocialScorecardMetadata {
  if (!header || header.length > SOCIAL_SCORECARD_MAX_HEADER_BYTES || /[^\x20-\x7e]/.test(header)) {
    throw new Error("Invalid scorecard metadata header");
  }
  return SocialScorecardMetadataSchema.parse(JSON.parse(header));
}

export function validateSocialScorecardPng(image: Uint8Array): void {
  if (image.byteLength < 33 || image.byteLength > SOCIAL_SCORECARD_MAX_IMAGE_BYTES
    || image[0] !== 137 || image[1] !== 80 || image[2] !== 78 || image[3] !== 71
    || image[4] !== 13 || image[5] !== 10 || image[6] !== 26 || image[7] !== 10
    || image[12] !== 73 || image[13] !== 72 || image[14] !== 68 || image[15] !== 82) {
    throw new Error("Invalid scorecard PNG");
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(16) !== SOCIAL_PREVIEW_WIDTH || view.getUint32(20) !== SOCIAL_PREVIEW_HEIGHT) {
    throw new Error("Invalid scorecard image dimensions");
  }
}

export function socialScorecardContentId(metadata: SocialScorecardMetadata): string {
  return sha256Hex(`pharos-social-scorecard:v1:${stableJsonStringifyV1(SocialScorecardMetadataSchema.parse(metadata))}`);
}

export function sealSocialScorecard(metadata: SocialScorecardMetadata, image: Uint8Array): { id: string; record: SocialScorecardRecord } {
  const admitted = SocialScorecardMetadataSchema.parse(metadata);
  validateSocialScorecardPng(image);
  if (sha256HexFromBytes(image) !== admitted.imageSha256) throw new Error("Scorecard image hash mismatch");
  return {
    id: socialScorecardContentId(admitted),
    record: { schemaVersion: 1, metadata: admitted, imageBase64: bytesToBase64(image) },
  };
}

export function openSocialScorecard(id: string, raw: string): { metadata: SocialScorecardMetadata; image: Uint8Array } {
  if (!isSocialScorecardId(id) || raw.length > SOCIAL_SCORECARD_MAX_RECORD_BYTES) throw new Error("Invalid scorecard record");
  const record = SocialScorecardRecordSchema.parse(JSON.parse(raw));
  if (socialScorecardContentId(record.metadata) !== id) throw new Error("Scorecard content identity mismatch");
  const image = base64ToBytes(record.imageBase64);
  validateSocialScorecardPng(image);
  if (sha256HexFromBytes(image) !== record.metadata.imageSha256) throw new Error("Scorecard image hash mismatch");
  return { metadata: record.metadata, image };
}

export function socialScorecardDate(metadata: SocialScorecardMetadata): string {
  return new Date(metadata.asOfSec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function socialScorecardTitle(metadata: SocialScorecardMetadata): string {
  return metadata.subject.kind === "overview"
    ? "Stablecoin Safety Scores"
    : `${metadata.subject.symbol} Safety Score`;
}

export function socialScorecardSummary(metadata: SocialScorecardMetadata): string {
  const subject = metadata.subject;
  return subject.kind === "overview"
    ? `${subject.ratedCount} rated of ${subject.totalCount} stablecoins; ${subject.notRatedCount} not rated; ${subject.unavailableCount} unavailable.`
    : `${subject.name}: published grade ${subject.grade}${subject.score === null ? " (not rated)" : `, Safety Score ${subject.score}/100`}.`;
}
