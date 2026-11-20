import { describe, expect, it } from "vitest";
import { projectV9WireBody } from "../report-cards-v9-freshness";

async function project(text: string, width: number) {
  const bytes = new TextEncoder().encode(text);
  return new Response(projectV9WireBody(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += width) controller.enqueue(bytes.slice(index, index + width));
      controller.close();
    },
  }), { operands: false, reserveAdmission: false })).text();
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

  it("omits complete admission objects across UTF-8 and field boundaries", async () => {
    const card = '{"id":"€","reserveCompositionAdmission":{"reasons":["age"],"age":{"compositionAsOfSec":-86400}},"score":35}';
    expect(await project(`{"publicationHealth":{},"cards":[${card},${card}],"other":{"rows":[1,2]}}`, 1))
      .toBe('{"publicationHealth":{},"cards":[{"id":"€","score":35},{"id":"€","score":35}],"other":{"rows":[1,2]}}');
  });

  it("preserves source generation keys that collide with card diagnostics", async () => {
    const source = '"source":{"sourceGenerations":{"dex":"generation","reserveCompositionAdmission":"generation"}}';
    const diagnostic = ',"reserveCompositionAdmission":{"reasons":["no-review"]}';
    expect(await project(`{"cards":[{"id":"mxne-real-mxn"${diagnostic}}],${source}}`, 1))
      .toBe(`{"cards":[{"id":"mxne-real-mxn"}],${source}}`);
  });

  it("rejects an interrupted materialization", async () => {
    await expect(project('{"publicationHealth":{},"pillarFreshness":{"dexMaxAgeSec":1', 1)).rejects.toThrow("Incomplete");
  });
});
