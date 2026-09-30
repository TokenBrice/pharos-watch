// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildCemeteryDatasetCitation, CemeteryDataset } from "@/components/cemetery/cemetery-dataset";
import { CemeteryDatasetCopyCitation } from "@/components/cemetery/cemetery-dataset-copy";
import { CEMETERY_DATASET_META } from "@/lib/cemetery-dataset-meta";

vi.mock("next/link", async () => {
  // Vitest hoists this factory, so the mock helper must load within that boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

describe("CemeteryDataset", () => {
  const html = renderToStaticMarkup(<CemeteryDataset />);

  it("anchors the section at #dataset so the Dataset JSON-LD @id resolves", () => {
    expect(html).toMatch(/<section[^>]*id="dataset"/);
  });

  it("links the downloads, feed, Telegram channel and cemetery Timeline filter", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
    expect(hrefs).toEqual([
      "/datasets/stablecoin-cemetery.json",
      "/datasets/stablecoin-cemetery.csv",
      "/feed/cemetery.xml",
      "https://t.me/pharoswatch",
      "/timeline/?type=cemetery.*&window=alltime",
    ]);
    expect(html).toMatch(/href="https:\/\/t\.me\/pharoswatch"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("prints the export's record count, schema, license and checksum", () => {
    const body = text(html);
    expect(body).toContain(
      `${CEMETERY_DATASET_META.rowCount} records · schema ${CEMETERY_DATASET_META.schemaVersion} · ${CEMETERY_DATASET_META.license} license`,
    );
    expect(body).toContain(`checksum ${CEMETERY_DATASET_META.sourceChecksumShort}`);
  });

  it("shows the citation it copies", () => {
    expect(text(html)).toContain(buildCemeteryDatasetCitation());
  });
});

describe("buildCemeteryDatasetCitation", () => {
  const meta = { ...CEMETERY_DATASET_META, schemaVersion: "2.0", rowCount: 7, license: "MIT", updatedAt: "2026-01-05" };

  it("cites schema, record count, latest-record day and the absolute JSON URL", () => {
    expect(buildCemeteryDatasetCitation(meta)).toBe(
      `Pharos, "Stablecoin Cemetery Dataset," schema 2.0, 7 records, latest record added Jan 5, 2026. ${SITE_ORIGIN}/datasets/stablecoin-cemetery.json (MIT).`,
    );
  });

  it("drops the latest-record clause when the export has no updatedAt", () => {
    expect(buildCemeteryDatasetCitation({ ...meta, updatedAt: null })).toBe(
      `Pharos, "Stablecoin Cemetery Dataset," schema 2.0, 7 records. ${SITE_ORIGIN}/datasets/stablecoin-cemetery.json (MIT).`,
    );
  });
});

describe("CemeteryDatasetCopyCitation", () => {
  it("copies the citation and announces it politely", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CemeteryDatasetCopyCitation citation="Pharos, cite me." />);
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Copy citation" }));
    expect(writeText).toHaveBeenCalledWith("Pharos, cite me.");
    await vi.waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Citation copied.");
    });
  });
});
