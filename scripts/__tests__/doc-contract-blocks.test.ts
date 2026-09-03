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
  END_MARKER as API_END_MARKER,
  START_MARKER as API_START_MARKER,
  loadOpenapi,
  renderGeneratedBlock as renderApiReferenceBlock,
} from "../maintenance/generate-api-reference";

const ROOT = resolve(import.meta.dirname, "../..");

function readDocument(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8");
}

describe("generated documentation contract blocks", () => {
  it("uses one unique inline marker pair per source-backed value", () => {
    const ids = DOC_CONTRACT_BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const block of DOC_CONTRACT_BLOCKS) {
      expect(block.value).not.toContain("\n");
      const document = readDocument(block.file);
      expect(document.split(docContractStartMarker(block.id))).toHaveLength(2);
      expect(document.split(docContractEndMarker(block.id))).toHaveLength(2);
      expect(document).toContain(renderDocContractBlock(block));
    }
  });

  it.each(DOC_CONTRACT_BLOCKS)("detects drift in $id", (block) => {
    const drift = findDocContractDrift((file) => {
      const document = readDocument(file);
      return file === block.file
        ? document.replace(renderDocContractBlock(block), `${docContractStartMarker(block.id)}drift${docContractEndMarker(block.id)}`)
        : document;
    });

    expect(drift.map((entry) => entry.id)).toContain(block.id);
  });

  it("keeps the source-backed endpoint examples under the existing API marker", () => {
    const document = readDocument("docs/api-reference.md");
    const start = document.indexOf(API_START_MARKER);
    const end = document.indexOf(API_END_MARKER);
    const found = document.slice(start, end + API_END_MARKER.length);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(found).toBe(renderApiReferenceBlock(loadOpenapi()));
  });
});
