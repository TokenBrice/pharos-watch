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

});
