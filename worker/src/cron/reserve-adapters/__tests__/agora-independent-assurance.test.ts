import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { AGORA_INDEPENDENT_ASSURANCE_PROFILE } from "../agora-independent-assurance";

const manifest = getIndependentAssuranceManifest("AUSD");
const prepareIndexHtml = AGORA_INDEPENDENT_ASSURANCE_PROFILE.prepareIndexHtml!;
const reportDateFromCandidate = AGORA_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate!;
const isReportCandidate = AGORA_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate;

const REVIEWED_HASH = manifest.reportSha256.toLowerCase();
const S3_JULY = `https://fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/agora.docs.buildwithfern.com/${REVIEWED_HASH}/docs/assets/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Signature=abcd`;
const S3_JUNE = "https://fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/agora.docs.buildwithfern.com/a7e3e708ecba5f1826066cb1ba633eb231ceb1765bb76a54cb6994be07eaf34c/docs/assets/2026%20Jun%20-%20Agora%20Dollar%20Reserve%20Report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Signature=efgh";
const OLD_MIRROR = "https://files.buildwithfern.com/agora.docs.buildwithfern.com/938a11767a399cc2cfd2a15efc4cdfab65a53e59402e61c9e166b5354b5c9673/docs/assets/2026%20May%20-%20Agora%20Dollar%20Reserve%20Report.pdf";

function indexHtml(...links: string[]) {
  return `<html><body>${links.map((href) => `<a href="${href}">report</a>`).join("\n")}</body></html>`;
}

describe("Agora reviewed index link verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rewrites the signed July link to the reviewed stable mirror", async () => {
    const prepared = await prepareIndexHtml(indexHtml(S3_JULY, S3_JUNE, OLD_MIRROR), new AbortController().signal);
    expect(prepared).not.toContain("fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/" + REVIEWED_HASH);
    expect(prepared).toContain(`href="${manifest.reportUrl}"`);
    expect(prepared).toContain(S3_JUNE);
  });

  it("passes through an already-stable reviewed link without double counting", async () => {
    const prepared = await prepareIndexHtml(indexHtml(S3_JULY, manifest.reportUrl), new AbortController().signal);
    expect(prepared).toContain(`href="${manifest.reportUrl}"`);
    expect(prepared).not.toContain("fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/" + REVIEWED_HASH);
  });

  it("fails closed when the reviewed July link is missing", async () => {
    await expect(prepareIndexHtml(indexHtml(S3_JUNE, OLD_MIRROR), new AbortController().signal)).rejects.toThrow("reviewed July report link missing or ambiguous");
  });

  it("fails closed when the July link is duplicated", async () => {
    await expect(prepareIndexHtml(indexHtml(S3_JULY, S3_JULY), new AbortController().signal)).rejects.toThrow("reviewed July report link missing or ambiguous");
  });

  it("fails closed when the July path hash drifts", async () => {
    const drifted = S3_JULY.replace(REVIEWED_HASH, "0".repeat(64));
    await expect(prepareIndexHtml(indexHtml(drifted), new AbortController().signal)).rejects.toThrow("reviewed July report link missing or ambiguous");
  });

  it("parses Fern report dates across both naming conventions", () => {
    expect(reportDateFromCandidate("https://x/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "2026 Jul - Agora Dollar Reserve Report")).toBe("2026-07-31");
    expect(reportDateFromCandidate("https://x/2026%20Jun%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "")).toBe("2026-06-30");
    expect(reportDateFromCandidate("https://x/Management%20Report%20on%20Agora%20Dollar%20and%20Reserve%20Assets%20as%20of%2012.31.25.pdf", "")).toBe("2025-12-31");
    expect(reportDateFromCandidate("https://x/other.pdf", "")).toBeNull();
  });

  it("accepts only Agora reserve-report candidates", () => {
    expect(isReportCandidate("https://x/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "")).toBe(true);
    expect(isReportCandidate("https://x/Management%20Report%20on%20Agora%20Dollar%20as%20of%2012.31.25.pdf", "")).toBe(true);
    expect(isReportCandidate("https://x/whitepaper.pdf", "")).toBe(false);
  });

  it("reconciles the July 31 examination with the excluded-inventory adjustment row", () => {
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "241476955",
      liabilityTotal: "240745867",
    });
    expect(manifest.adjustments).toEqual([expect.objectContaining({ code: "ausd-created-excluded", amount: "24127673" })]);
    expect(Number(manifest.reportedAssetTotal) / Number(manifest.reportedLiabilityTotal)).toBeCloseTo(1.00304, 5);
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest,
      assets: manifest.assets.filter((row) => row.code !== "stablecoins"),
    })).toThrow("computed asset total 235413169 does not match manifest 241476955");
  });
});
