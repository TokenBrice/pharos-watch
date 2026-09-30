import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { formatCurrency } from "@shared/lib/format";
import {
  EDITORIAL_PREVIEW_MAX_CHARS,
  EDITORIAL_TITLES,
  getObituaryLead,
  getObituaryPreview,
  isEditorialId,
  splitObituarySentences,
} from "@/lib/cemetery-editorial";

function entry(id: string) {
  const found = CEMETERY_ENTRIES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing cemetery entry ${id}`);
  return found;
}

describe("splitObituarySentences", () => {
  it("never splits inside a decimal and ends a sentence on a figure", () => {
    expect(splitObituarySentences("Once the largest at $23.5B. Paxos stopped minting at 1.0 ratio.")).toEqual([
      "Once the largest at $23.5B.",
      "Paxos stopped minting at 1.0 ratio.",
    ]);
  });

  it("keeps abbreviations inside their sentence", () => {
    expect(
      splitObituarySentences(
        "Backed by U.S. Treasuries, e.g. short bills. Acme Inc. Holdings sued in Doe v. Coinbase vs. others. Done.",
      ),
    ).toEqual([
      "Backed by U.S. Treasuries, e.g. short bills.",
      "Acme Inc. Holdings sued in Doe v. Coinbase vs. others.",
      "Done.",
    ]);
  });

  it("splits after closing straight and curly quotes", () => {
    expect(splitObituarySentences('Dubbed a "bank run." IRON fell. It was \u201Cover.\u201D Holders left.')).toEqual([
      'Dubbed a "bank run."',
      "IRON fell.",
      "It was \u201Cover.\u201D",
      "Holders left.",
    ]);
    expect(splitObituarySentences("It meant 'loss-bearing.' The exchange froze.")).toEqual([
      "It meant 'loss-bearing.'",
      "The exchange froze.",
    ]);
  });

  it("treats a lowercase-led ticker as a new sentence", () => {
    expect(splitObituarySentences("Synthetix migrated. sUSD lost its peg.")).toEqual([
      "Synthetix migrated.",
      "sUSD lost its peg.",
    ]);
  });

  it("returns the unterminated tail as the last sentence and nothing for blank input", () => {
    expect(splitObituarySentences("One. Two without a stop")).toEqual(["One.", "Two without a stop"]);
    expect(splitObituarySentences("   ")).toEqual([]);
  });

  it("partitions every real obituary without losing text", () => {
    for (const { id, obituary } of CEMETERY_ENTRIES) {
      expect(splitObituarySentences(obituary).join(" "), id).toBe(obituary.trim().replace(/\s+/g, " "));
    }
  });
});

describe("obituary previews on real records", () => {
  const CASES: Array<[string, string]> = [
    ["busd-binance-usd-2023-02", "Once the third-largest stablecoin at $23.5B."],
    ["mim-abracadabra", "Once one of DeFi's largest CDP stablecoins"],
    ["fei-fei-usd-2022-08", "Raised $1.3B in ETH at launch"],
    ["usdn-neutrino-usd-2022-04", "Succumbed to an algorithmic death spiral"],
    ["iron-iron-2021-06", "Dubbed crypto's \"first large-scale bank run.\""],
  ];

  it.each(CASES)("%s starts at sentence 1", (id, opening) => {
    const { obituary } = entry(id);
    expect(getObituaryLead(obituary).startsWith(opening)).toBe(true);
    expect(getObituaryPreview(obituary, { editorial: isEditorialId(id) }).startsWith(opening)).toBe(true);
    expect(obituary.startsWith(opening)).toBe(true);
  });

  it("gives BUSD's editorial preview exactly its first two sentences", () => {
    expect(getObituaryPreview(entry("busd-binance-usd-2023-02").obituary, { editorial: true })).toBe(
      "Once the third-largest stablecoin at $23.5B. The NYDFS ordered issuer Paxos to stop minting, while the SEC signaled intent to sue.",
    );
  });

  it("closes IRON's lead on the quoted sentence without adding a stop", () => {
    expect(getObituaryLead(entry("iron-iron-2021-06").obituary)).toBe("Dubbed crypto's \"first large-scale bank run.\"");
  });
});

describe("getObituaryLead / getObituaryPreview", () => {
  it("terminates an unpunctuated lead", () => {
    expect(getObituaryLead("Wound down quietly")).toBe("Wound down quietly.");
    expect(getObituaryLead("")).toBe("");
  });

  it("uses the lead sentence for non-editorial records", () => {
    expect(getObituaryPreview("First sentence. Second sentence.", { editorial: false })).toBe("First sentence.");
  });

  it("caps editorial previews on a word boundary with an ellipsis", () => {
    const long = `${"word ".repeat(100).trim()}. Second.`;
    const preview = getObituaryPreview(long, { editorial: true });
    expect(preview.length).toBeLessThanOrEqual(EDITORIAL_PREVIEW_MAX_CHARS);
    expect(preview.endsWith("word\u2026")).toBe(true);
  });
});

describe("EDITORIAL_TITLES", () => {
  it("titles only real cemetery records, and the titled set is the editorial set", () => {
    const ids = new Set(CEMETERY_ENTRIES.map((candidate) => candidate.id));
    for (const id of Object.keys(EDITORIAL_TITLES)) {
      expect(ids.has(id), id).toBe(true);
      expect(isEditorialId(id)).toBe(true);
    }
    expect(isEditorialId("__proto__")).toBe(false);
    expect(isEditorialId("usdc-m-multichain-usdc-2023-07")).toBe(false);
  });

  it("states no UST figure other than its recorded peak", () => {
    const ust = entry("ust-terrausd-2022-05");
    const title = EDITORIAL_TITLES["ust-terrausd-2022-05"];
    expect(ust.peakMcap).toBeDefined();
    const peak = formatCurrency(ust.peakMcap ?? Number.NaN, 1);
    const figures = title.match(/\$?\d[\d.,]*\s*(?:[KMBT]\b|thousand|million|billion|trillion)?/gi) ?? [];
    for (const figure of figures) {
      expect(peak).toContain(figure.replace(/\s+/g, ""));
    }
    expect(title).not.toMatch(/\$?40\s*(?:B\b|billion)/i);
  });
});
