import { describe, expect, it } from "vitest";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "../../test-utils/social-scorecard";
import { SocialScorecardCreateSchema } from "../../types/social-scorecard";
import {
  decodeSocialScorecardMetadata, encodeSocialScorecardMetadata, openSocialScorecard,
  sealSocialScorecard, socialScorecardContentId, socialScorecardLivePath,
} from "../social-scorecard";

describe("retained social scorecard identity", () => {
  it("roundtrips an ASCII metadata header without recomputing the published grade", () => {
    const metadata = makeScorecardMetadataFixture();
    metadata.subject = { ...metadata.subject, kind: "stablecoin", id: "usdc-circle", name: "Coin <&> €", symbol: "USDC", score: 82, grade: "A", ratingStatus: "rated" };
    const header = encodeSocialScorecardMetadata(metadata);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeSocialScorecardMetadata(header)).toEqual(metadata);
    expect(decodeSocialScorecardMetadata(header).subject).toMatchObject({ score: 82, grade: "A" });
  });

  it("seals pixels and all publication provenance into one stable content identity", () => {
    const metadata = makeScorecardMetadataFixture();
    const sealed = sealSocialScorecard(metadata, makeScorecardImageFixture());
    expect(openSocialScorecard(sealed.id, JSON.stringify(sealed.record))).toEqual({ metadata, image: makeScorecardImageFixture() });
    expect(socialScorecardContentId({ ...metadata, rendererRevision: "scorecard-2" })).not.toBe(sealed.id);
    expect(socialScorecardContentId({ ...metadata, publication: { ...metadata.publication, methodologyVersion: "10.38" } })).not.toBe(sealed.id);
    expect(socialScorecardContentId({ ...metadata, publication: { ...metadata.publication, publicationGenerationId: "next-generation" } })).not.toBe(sealed.id);
    expect(socialScorecardContentId({ ...metadata, asOfSec: metadata.asOfSec - 1 })).not.toBe(sealed.id);
  });

  it("rejects altered pixels, dimensions, metadata, wrong IDs and missing headers", () => {
    const metadata = makeScorecardMetadataFixture();
    const image = makeScorecardImageFixture();
    const sealed = sealSocialScorecard(metadata, image);
    image[32] ^= 1;
    expect(() => sealSocialScorecard(metadata, image)).toThrow(/hash mismatch/);
    const changed = { ...sealed.record, metadata: { ...metadata, publishedAtSec: metadata.publishedAtSec + 1 } };
    expect(() => openSocialScorecard(sealed.id, JSON.stringify(changed))).toThrow(/identity mismatch/);
    expect(() => openSocialScorecard("f".repeat(64), JSON.stringify(sealed.record))).toThrow(/identity mismatch/);
    const dimensions = makeScorecardImageFixture();
    dimensions[23] = 1;
    expect(() => sealSocialScorecard(metadata, dimensions)).toThrow(/dimensions/);
    expect(() => decodeSocialScorecardMetadata(null)).toThrow();
    expect(() => decodeSocialScorecardMetadata("x".repeat(4097))).toThrow();
  });

  it("accepts only identity input, never client scores, prose or URLs", () => {
    expect(SocialScorecardCreateSchema.safeParse({ stablecoinId: "usdc-circle" }).success).toBe(true);
    expect(SocialScorecardCreateSchema.safeParse({ stablecoinId: "safety-scores" }).success).toBe(true);
    for (const extra of [{ score: 100 }, { grade: "A+" }, { url: "https://evil.test" }, { title: "Private input" }]) {
      expect(SocialScorecardCreateSchema.safeParse({ stablecoinId: "usdc-circle", ...extra }).success).toBe(false);
    }
  });

  it("supports an honest overview without manufacturing an aggregate grade", () => {
    const metadata = makeScorecardMetadataFixture();
    metadata.subject = { kind: "overview", id: "safety-scores", ratedCount: 8, notRatedCount: 1, unavailableCount: 1, totalCount: 10, averageScore: 72.5 };
    expect(socialScorecardLivePath(metadata)).toBe("/safety-scores/");
    const sealed = sealSocialScorecard(metadata, makeScorecardImageFixture());
    expect(openSocialScorecard(sealed.id, JSON.stringify(sealed.record)).metadata.subject).toEqual(metadata.subject);
    const inconsistentSubject = { ...metadata.subject, totalCount: 11 };
    expect(() => sealSocialScorecard({ ...metadata, subject: inconsistentSubject }, makeScorecardImageFixture())).toThrow();
  });
});
