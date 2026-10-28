// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildPublicDatasetCitation,
  PHAROS_DATA_LICENSE_URL,
  PUBLIC_DATASET_JSON_LD_DESCRIPTORS,
} from "@/lib/analytics-dataset-json-ld";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import { ApiReferencePanel } from "./api-reference-panel";

// Scrollspy behavior is independent of the server-rendered auth guidance.
vi.mock("@/components/api-reference-layout", () => ({
  ApiReferenceLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("API reference authentication guidance", () => {
  it("links the FAQ to canonical auth instead of repeating an exemption roster", async () => {
    render(await ApiReferencePanel());
    const question = screen.getByText("Do I need an API key for every endpoint?").closest("details")!;
    const link = within(question).getByText("Public API Auth").closest("a");
    expect(link?.getAttribute("href")).toBe("/api/reference#public-api-auth");
    const auth = document.getElementById("public-api-auth")!;
    expect(auth).not.toBeNull();
    expect(within(auth).getByText("GET /api/dependency-graph/v1")).toBeTruthy();
    expect(within(auth).getByText("GET /api/dependency-scenarios/v1")).toBeTruthy();
    expect(question.querySelector("ul, ol")).toBeNull();
    expect(within(question).queryByText(/safety-grades|telegram-webhook|dependency-graph/)).toBeNull();
    const facts = screen.getByText("Quick facts").parentElement!;
    expect(within(facts).queryByText(/no-key|exempt/i)).toBeNull();
    const faqScript = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .find((script) => script.textContent?.includes('"@type":"FAQPage"'));
    const faq = JSON.parse(faqScript!.textContent!) as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    const structuredAnswer = faq.mainEntity.find((item) => item.name === question.querySelector("summary")?.textContent);
    expect(structuredAnswer?.acceptedAnswer.text).toBe(question.querySelector("p")?.textContent);
  });
});

describe("API reference dataset cards", () => {
  it("states license, snapshot clock and methodology while preserving download links", async () => {
    render(await ApiReferencePanel());

    for (const descriptor of PUBLIC_DATASET_JSON_LD_DESCRIPTORS) {
      const card = document.getElementById(`dataset-${descriptor.slug}`);
      expect(card, descriptor.slug).not.toBeNull();
      const meta = descriptor.export._meta;
      const metadata = card!.textContent ?? "";

      expect(metadata).toContain(`MIT · As of ${meta.asOfISO} · Methodology ${meta.methodologyLabel}`);
      expect(within(card as HTMLElement).getByRole("link", { name: "MIT" }).getAttribute("href")).toBe(
        PHAROS_DATA_LICENSE_URL,
      );
      expect(card!.querySelector("time")?.getAttribute("datetime")).toBe(meta.asOfISO);
      expect(card!.querySelector("time")?.textContent).toBe(meta.asOfISO);

      for (const format of ["json", "csv", "ndjson"]) {
        expect(
          within(card as HTMLElement)
            .getByRole("link", { name: format.toUpperCase() })
            .getAttribute("href"),
        ).toBe(`/datasets/${descriptor.slug}/latest.${format}`);
      }
      expect(within(card as HTMLElement).getByRole("link", { name: "Sheets CSV" }).getAttribute("href")).toBe(
        `/sheets/${descriptor.slug}.csv`,
      );
    }
  });

  it("copies the canonical dated citation once and announces success politely", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(await ApiReferencePanel());

    const descriptor = PUBLIC_DATASET_JSON_LD_DESCRIPTORS.find((candidate) => candidate.slug === "depeg-history");
    if (!descriptor) throw new Error("Missing depeg-history descriptor");
    const card = document.getElementById(`dataset-${descriptor.slug}`) as HTMLElement;
    const button = within(card).getByRole("button", { name: "Copy citation" });

    await act(async () => {
      fireEvent.click(button);
    });

    const citation = buildPublicDatasetCitation(descriptor);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(citation);
    expect(writeText.mock.calls[0][0]).toContain(
      `Pharos, "Pharos Depeg History Dataset," snapshot edition ${PUBLIC_DATASET_CURRENT_DATE}`,
    );
    expect(citation).toContain(`/datasets/depeg-history/${PUBLIC_DATASET_CURRENT_DATE}.json`);
    expect(citation).toContain("Data: https://pharos.watch/datasets/depeg-history/");
    expect(within(card).getByRole("status").textContent).toBe("Citation copied.");
  });

  it("does not announce success when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const previousExecCommand = document.execCommand;
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) });

    try {
      render(await ApiReferencePanel());
      const card = document.getElementById("dataset-scores-latest") as HTMLElement;
      const button = within(card).getByRole("button", { name: "Copy citation" });

      await act(async () => {
        fireEvent.click(button);
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(within(card).getByRole("status").textContent).toBe("");
      expect(card.textContent).not.toContain("Citation copied.");
    } finally {
      Object.defineProperty(document, "execCommand", { configurable: true, value: previousExecCommand });
    }
  });
});
