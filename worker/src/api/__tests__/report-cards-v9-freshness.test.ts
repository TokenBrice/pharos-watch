import { describe, expect, it } from "vitest";
import { legacyV9FreshnessBody } from "../report-cards-v9-freshness";

async function project(text: string, width: number) {
  const bytes = new TextEncoder().encode(text);
  return new Response(legacyV9FreshnessBody(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += width) controller.enqueue(bytes.slice(index, index + width));
      controller.close();
    },
  }))).text();
}

describe("V9 legacy freshness wire", () => {
  it.each([1, 7, 127, 4096])("omits only root operands across %s-byte chunks", async width => {
    const prefix = '{"publicationHealth":{"status":"current"},"cards":[{"text":"UTF-8 € with escaped \\\"pillarFreshness\\\" and \\\\ slash","pillarFreshness":{"nested":"untouched"}}]';
    const metadata = ', "pillarFreshness" : {"dexMaxAgeSec":5000,"dexObservedAtSec":[1234,null]}';
    const suffix = ',"score":7.7000e1,"source":{"sourceGenerations":{"dex":"actual-generation"}}}';
    expect(await project(prefix + metadata + suffix, width)).toBe(prefix + suffix);
    expect(await project(prefix + suffix, width)).toBe(prefix + suffix);
    expect(await project(prefix + metadata + '}', width)).toBe(prefix + '}');
  });

  it("handles JSON-escaped root keys without touching nested sibling keys", async () => {
    const text = '{"publicationHealth":{},"pillarFreshn\\u0065ss":{"dexMaxAgeSec":0,"dexObservedAtSec":[]},"other":{"pillarFreshness":{}}}';
    expect(await project(text, 1)).toBe('{"publicationHealth":{},"other":{"pillarFreshness":{}}}');
  });

  it("rejects an interrupted materialization", async () => {
    await expect(project('{"publicationHealth":{},"pillarFreshness":{"dexMaxAgeSec":1', 1)).rejects.toThrow("Incomplete");
  });
});
