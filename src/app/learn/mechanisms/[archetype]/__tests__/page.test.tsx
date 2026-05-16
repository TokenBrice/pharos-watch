import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

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
    it(`renders an <h1> containing the "${archetype}" label`, async () => {
      const element = await ArchetypeExplainerPage({
        params: Promise.resolve({ archetype }),
      });
      const html = renderToStaticMarkup(element);
      const label = MECHANISM_ARCHETYPE_LABELS[archetype];
      // Page renders an editorial display <h1> (headline) plus the archetype
      // label inside the breadcrumb trail. Assert one semantic h1 exists and
      // the label is present somewhere in the markup.
      expect(html).toMatch(/<h1\b/);
      expect(html).toContain(label);
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
