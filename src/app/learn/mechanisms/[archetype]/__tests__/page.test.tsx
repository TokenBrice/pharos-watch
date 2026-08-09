import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import ArchetypeExplainerPage, {
  generateStaticParams,
} from "@/app/learn/mechanisms/[archetype]/page";

describe("ArchetypeExplainerPage", () => {
  it("generateStaticParams returns exactly one entry per MechanismArchetype", () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(MECHANISM_ARCHETYPE_VALUES.length);
    expect(new Set(params.map((entry) => entry.archetype))).toEqual(
      new Set(MECHANISM_ARCHETYPE_VALUES),
    );
  });

  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    it(`renders exactly one semantic <h1> for "${archetype}"`, async () => {
      const element = await ArchetypeExplainerPage({
        params: Promise.resolve({ archetype }),
      });
      const html = renderToStaticMarkup(element);
      const matches = html.match(/<h1\b/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  }

  it("calls notFound() when handed an unknown archetype slug", async () => {
    notFoundMock.mockClear();
    await expect(
      ArchetypeExplainerPage({
        params: Promise.resolve({ archetype: "not-a-real-archetype" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
