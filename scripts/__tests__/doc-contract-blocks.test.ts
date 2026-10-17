import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOC_CONTRACT_BLOCKS,
  docContractEndMarker,
  docContractStartMarker,
  findDocContractDrift,
  renderDocContractBlock,
} from "../lib/doc-sync/contract-blocks";
import {
  ISOLATE_LOCAL_STATE_DOC_END,
  ISOLATE_LOCAL_STATE_DOC_START,
  renderIsolateLocalStateDocumentation,
} from "@shared/lib/isolate-local-state-registry";
import { renderOperatorOriginAccessEnvBlock } from "@shared/lib/env-contract";
const ROOT = resolve(import.meta.dirname, "../..");

function readDocument(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8");
}

const documents: ReadonlyMap<string, string> = new Map(
  [...new Set(DOC_CONTRACT_BLOCKS.map((block) => block.file))].map((file) => [file, readDocument(file)]),
);

describe("generated documentation contract blocks", () => {
  it.each(DOC_CONTRACT_BLOCKS)("detects drift in $id", (block) => {
    const drift = findDocContractDrift((file) => {
      const document = documents.get(file)!;
      return file === block.file
        ? document.replace(renderDocContractBlock(block), `${docContractStartMarker(block.id)}drift${docContractEndMarker(block.id)}`)
        : document;
    });

    expect(drift.map((entry) => entry.id)).toContain(block.id);
  });

  it("rejects duplicate markers even when the first block is current", () => {
    const block = DOC_CONTRACT_BLOCKS[0];
    for (const extra of [renderDocContractBlock(block), docContractStartMarker(block.id), docContractEndMarker(block.id)]) {
      const drift = findDocContractDrift((file) => documents.get(file)! + (file === block.file ? extra : ""));
      expect(drift.map((entry) => entry.id)).toContain(block.id);
    }
  });
  it.each([
    {
      id: "env contract",
      file: "docs/operator-origin-access.md",
      startMarker: "<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:BEGIN -->",
      endMarker: "<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:END -->",
      content: `\n${renderOperatorOriginAccessEnvBlock()}\n`,
    },
    {
      id: "isolate-local state registry",
      file: "docs/process/worker-infrastructure-appendix.md",
      startMarker: ISOLATE_LOCAL_STATE_DOC_START,
      endMarker: ISOLATE_LOCAL_STATE_DOC_END,
      content: renderIsolateLocalStateDocumentation().slice(
        ISOLATE_LOCAL_STATE_DOC_START.length,
        -ISOLATE_LOCAL_STATE_DOC_END.length,
      ),
    },
  ])("compares $id with its existing explicit markers", ({ content, ...markers }) => {
    const region = { ...markers, expected: `${markers.startMarker}${content}${markers.endMarker}` };
    const compare = (document: string) => findDocContractDrift(() => document, [region]);
    expect(compare(`before\n${region.expected}\nafter`)).toEqual([]);
    expect(compare(`${markers.startMarker}stale${markers.endMarker}`)).toEqual([
      expect.objectContaining({ id: region.id, found: `${markers.startMarker}stale${markers.endMarker}` }),
    ]);
    for (const document of [
      "",
      markers.startMarker,
      markers.endMarker,
      `${markers.endMarker}${markers.startMarker}`,
      `${region.expected}${region.expected}`,
      `${region.expected}${markers.startMarker}`,
      `${region.expected}${markers.endMarker}`,
    ]) {
      expect(compare(document)).toEqual([
        { file: region.file, id: region.id, expected: region.expected, found: null },
      ]);
    }
  });

});
