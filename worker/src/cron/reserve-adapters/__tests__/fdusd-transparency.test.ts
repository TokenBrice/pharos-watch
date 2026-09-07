import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, fetchPrimaryHtmlInput: vi.fn() };
});

vi.mock("../../../lib/fetch-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/fetch-retry")>();
  return { ...actual, fetchWithRetry: vi.fn() };
});

import {
  adaptFdusdReserveReport,
  fetchFdusdTransparencyReserves,
  selectNewestFdusdSignedReport,
} from "../fdusd-transparency";
import { fetchPrimaryHtmlInput } from "../helpers";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { TEST_SIGNAL as signal } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const INDEX_HTML = readFileSync(join(FIXTURES_DIR, "fdusd-transparency.html"), "utf8");
const JULY_INDEX_HTML = `
  <div role="listitem" class="transparency-report_item w-dyn-item">
    <div>Jul 2026</div>
    <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a866c81428740395febba47_B1-07-%20ISAE3000%20-%20Attestation%20Report%20on%20Reserves%20Account%20July%202026)%20-%20Draft.pdf">Download</a>
  </div>
  <div role="listitem" class="transparency-report_item w-dyn-item">
    <div>Jun 2026</div>
    <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a55fa1246d16025bd7f7d87_FDUSD%20Reserve%20accounts%20Report_JUN%202026%20(signed%20by%20Accountant).pdf">Download</a>
  </div>
`;
const REPORT_TEXT = readFileSync(join(FIXTURES_DIR, "fdusd-reserve-report.txt"), "utf8");
const JULY_REPORT_TEXT = readFileSync(join(FIXTURES_DIR, "fdusd-isae3000-july-glyph-fragmented.txt"), "utf8");
const config = {
  adapter: "fdusd-transparency",
  version: 1,
  semantics: "attestation-mix",
  inputs: {
    primary: { kind: "http-html", url: "https://www.firstdigitallabs.com/transparency" },
  },
} as LiveReservesConfig;

afterEach(() => {
  vi.clearAllMocks();
});

describe("FDUSD signed reserve reports", () => {
  it("selects the newest dated reserve-account report from the official index fixture", () => {
    expect(selectNewestFdusdSignedReport(INDEX_HTML)).toEqual({
      href: "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a55fa3b263f9436c944049d_ISAE3000%20-%20Attestation%20Report%20on%20Reserves%20Account%20(June%202026).pdf",
      reportPeriod: "Jun 2026",
      sortTimestamp: Date.parse("1 Jun 2026 UTC"),
    });
  });

  it("selects the newest official ISAE3000 reserve-account report over the prior signed image report", () => {
    expect(selectNewestFdusdSignedReport(JULY_INDEX_HTML)).toEqual({
      href: "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a866c81428740395febba47_B1-07-%20ISAE3000%20-%20Attestation%20Report%20on%20Reserves%20Account%20July%202026)%20-%20Draft.pdf",
      reportPeriod: "Jul 2026",
      sortTimestamp: Date.parse("1 Jul 2026 UTC"),
    });
  });

  it("rejects an index that does not expose a parseable dated signed report", () => {
    expect(() => selectNewestFdusdSignedReport(`
      <div role="listitem" class="transparency-report_item w-dyn-item">
        <div>Latest</div><a href="/FDUSD Reserve accounts Report (signed).pdf">Download</a>
      </div>
    `)).toThrow("layout-changed");
  });

  it("extracts composition and the report-period date from the signed report fixture", () => {
    const result = adaptFdusdReserveReport(REPORT_TEXT, "https://issuer.example/june.pdf");

    expect(result.slices).toEqual([
      { name: "U.S. Treasury Bills", pct: 85.3, risk: "very-low" },
      { name: "Cash", pct: 10.4, risk: "very-low" },
      { name: "Fixed Deposit", pct: 4.3, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      asOf: "June 30, 2026",
      sourceTimestamp: Date.UTC(2026, 5, 30) / 1000,
      freshnessMode: "verified",
      totalReserveUsd: 351_727_000,
      reportUrl: "https://issuer.example/june.pdf",
    });
  });

  it("extracts a day-first report-period date with a timezone suffix", () => {
    const dayFirstReport = REPORT_TEXT.replace(
      "June 30, 2026 at 9:00PM ET",
      "as of 31 July 2026 at 9:00pm Eastern Time",
    );
    const result = adaptFdusdReserveReport(dayFirstReport);

    expect(result.metadata).toMatchObject({
      asOf: "31 July 2026",
      sourceTimestamp: Date.parse("31 July 2026") / 1000,
    });
  });

  it("extracts the July ISAE3000 composition from glyph-fragmented PDF text", () => {
    const result = adaptFdusdReserveReport(JULY_REPORT_TEXT, "https://issuer.example/july.pdf");

    expect(result.slices).toEqual([
      { name: "U.S. Treasury Bills", pct: 75.9, risk: "very-low" },
      { name: "Cash", pct: 20.4, risk: "very-low" },
      { name: "Fixed Deposit", pct: 3.7, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      asOf: "July 31, 2026",
      sourceTimestamp: 1_785_456_000,
      freshnessMode: "verified",
      totalReserveUsd: 351_643_471.73,
      reportUrl: "https://issuer.example/july.pdf",
    });
  });

  it("fails without emitting a row when the newest report cannot be parsed", async () => {
    vi.mocked(fetchPrimaryHtmlInput).mockResolvedValue(INDEX_HTML);
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response("not a reserve report", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));

    await expect(fetchFdusdTransparencyReserves({} as never, config, signal)).rejects.toThrow("layout-changed");
  });

  it("fails without emitting a row when the report fetch fails", async () => {
    vi.mocked(fetchPrimaryHtmlInput).mockResolvedValue(INDEX_HTML);
    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await expect(fetchFdusdTransparencyReserves({} as never, config, signal)).rejects.toThrow("Fetch failed");
  });
});
