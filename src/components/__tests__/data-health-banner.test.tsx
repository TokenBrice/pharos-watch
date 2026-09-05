import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataHealthBanner } from "../data-health-banner";
import { deriveDataHealth } from "@/lib/data-health";

describe("DataHealthBanner", () => {
  it("distinguishes source warnings, retry failures, and old producer snapshots", () => {
    const input = { label: "Liquidity", dataUpdatedAt: Date.now(), staleTime: 3600_000, hasData: true };
    const render = (overrides: Partial<Parameters<typeof deriveDataHealth>[0]>) =>
      renderToStaticMarkup(<DataHealthBanner entries={[deriveDataHealth({ ...input, ...overrides })]} />);
    const quality = render({ meta: { status: "degraded", warning: '199 - "Quality drift"' } });
    expect(quality).toContain("Data quality warning");
    expect(quality).not.toContain("running behind");
    expect(render({ error: new Error("offline") })).toContain("Refresh failed; showing saved data");
    expect(render({ dataUpdatedAt: Date.now() - 9 * 3600_000 })).toContain("Live refresh is running behind");
  });
});
