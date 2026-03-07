import { describe, expect, it } from "vitest";
import { getDigestBodyParagraphs, splitDigestParagraphs } from "@/lib/digest";

describe("splitDigestParagraphs", () => {
  it("splits digest text on blank lines and trims whitespace", () => {
    expect(splitDigestParagraphs(" First paragraph. \n\nSecond paragraph.\n\n Third paragraph. "))
      .toEqual(["First paragraph.", "Second paragraph.", "Third paragraph."]);
  });

  it("handles Windows newlines and empty input", () => {
    expect(splitDigestParagraphs("First.\r\n\r\nSecond.")).toEqual(["First.", "Second."]);
    expect(splitDigestParagraphs(null)).toEqual([]);
  });
});

describe("getDigestBodyParagraphs", () => {
  it("prefers extended editorial paragraphs when present", () => {
    expect(getDigestBodyParagraphs({
      digest: "Fallback summary.",
      digestExtended: "Lead paragraph.\n\nSecond paragraph.",
    })).toEqual(["Lead paragraph.", "Second paragraph."]);
  });

  it("falls back to digest text when extended copy is unavailable", () => {
    expect(getDigestBodyParagraphs({
      digest: "Fallback summary.",
      digestExtended: null,
    })).toEqual(["Fallback summary."]);
  });
});
