import { describe, expect, it } from "vitest";
import {
  buildCoinIdResolver,
  buildFile,
  filterAgainstExisting,
  renderAppendBlock,
  type Candidate,
} from "../build-annotation-candidates";
import type { StablecoinMeta } from "@shared/types";

function coin(id: string, symbol: string, name = symbol): StablecoinMeta {
  return { id, symbol, name, flags: {} } as StablecoinMeta;
}

describe("buildCoinIdResolver", () => {
  it("keeps shared labels ambiguous after later duplicate fields", () => {
    const resolveCoinId = buildCoinIdResolver([
      coin("usdx-hex-trust", "USDX", "Hex Trust USDX"),
      coin("usdx-kava", "USDX", "USDX"),
    ]);

    expect(resolveCoinId("USDX")).toBeNull();
    expect(resolveCoinId("usdx-hex-trust")).toBe("usdx-hex-trust");
    expect(resolveCoinId("usdx-kava")).toBe("usdx-kava");
  });

  it("resolves labels that belong to only one stablecoin", () => {
    const resolveCoinId = buildCoinIdResolver([coin("unique-usd", "UUSD", "Unique USD")]);

    expect(resolveCoinId(" uusd ")).toBe("unique-usd");
    expect(resolveCoinId("Unique USD")).toBe("unique-usd");
  });
});

describe("filterAgainstExisting", () => {
  const candidate = (date: string, kind = "launch"): Candidate => ({
    coinId: "example-usd",
    date,
    kind,
    description: "Example candidate",
    source: "https://example.com",
  });

  it("does not requeue events covered by the last editorial sweep", () => {
    expect(
      filterAgainstExisting(
        [candidate("2026-08-10"), candidate("2026-08-11"), candidate("2026-08-12")],
        "",
        "2026-08-11",
      ),
    ).toEqual([candidate("2026-08-12")]);
  });

  it("still rejects duplicate rows newer than the last sweep", () => {
    const queued = "## 2026-08-12\n- example-usd | launch | Example candidate | source: https://example.com\n";

    expect(filterAgainstExisting([candidate("2026-08-12")], queued, "2026-08-11")).toEqual([]);
  });

  it.each([null, "2026-08-10"])("preserves the review cursor %s across source recovery", (lastSweptAt) => {
    const footer = lastSweptAt == null ? "" : `<!-- last_swept_at: ${lastSweptAt} -->`;
    const generated = buildFile(footer, renderAppendBlock("2026-08-12", [], ["depeg tape unavailable — skipped"]));
    const readCursor = (body: string) => /<!-- last_swept_at: (\d{4}-\d{2}-\d{2}) -->/.exec(body)?.[1] ?? null;
    expect(readCursor(generated)).toBe(lastSweptAt);

    // Both recovered history and a later same-day event must remain eligible.
    const recovered = [candidate("2026-08-11", "depeg"), candidate("2026-08-12", "depeg")];
    const fresh = filterAgainstExisting(recovered, generated, readCursor(generated));
    expect(fresh).toEqual(recovered);
    const updated = buildFile(generated, renderAppendBlock("2026-08-12", fresh, []));
    expect(updated).toContain("- 2026-08-11 | example-usd | depeg |");
    expect(updated).toContain("- 2026-08-12 | example-usd | depeg |");
    expect(readCursor(updated)).toBe(lastSweptAt);
    expect(updated.match(/<!-- last_swept_at:/g) ?? []).toHaveLength(lastSweptAt == null ? 0 : 1);
    expect(filterAgainstExisting(recovered, updated, readCursor(updated))).toEqual([]);
  });
});
