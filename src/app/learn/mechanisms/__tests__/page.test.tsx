import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import MechanismExplainersHub from "@/app/learn/mechanisms/page";

describe("MechanismExplainersHub", () => {
  it("renders an <h1> and a tile for every archetype linking to /learn/mechanisms/<slug>/", () => {
    const html = renderToStaticMarkup(<MechanismExplainersHub />);

    expect(html).toMatch(/<h1\b/);

    // 7 since methodology v9.14 registered `commodity-claim`.
    expect(MECHANISM_ARCHETYPE_VALUES).toHaveLength(7);
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(html).toContain(`href="/learn/mechanisms/${archetype}/"`);
      expect(html).toContain(MECHANISM_ARCHETYPE_LABELS[archetype]);
    }
  });
});
