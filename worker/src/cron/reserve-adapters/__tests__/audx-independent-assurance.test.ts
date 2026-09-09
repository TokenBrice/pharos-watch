import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const reviewed = getIndependentAssuranceManifest("AUDX");

afterEach(() => vi.unstubAllGlobals());

describe("audx-independent-assurance", () => {
  it("fails closed when the reviewed report href is renamed on the transparency index", async () => {
    const network = installAdapterNetwork({
      html: {
        [reviewed.officialIndexUrl]: `<a data-report-url="${reviewed.reportUrl}">July 2026</a>`,
      },
    });

    await expect(runAdapter("audx-independent-assurance", "audx-aussie-dollar-token", {
      network,
      nowSec: 1_757_003_600,
    })).rejects.toThrow(/reviewed report URL is missing or duplicated/);
    expect(network.requests.map((request) => request.url)).toEqual([reviewed.officialIndexUrl]);
  });
});
