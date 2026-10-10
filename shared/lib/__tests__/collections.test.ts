import { describe, expect, it } from "vitest";
import { chunkArray } from "../collections";

describe("chunkArray", () => {
  it.each([5, 12, 40, 80])("preserves contiguous consumer partitions at size %i", (size) => {
    expect(chunkArray([], size)).toEqual([]);
    expect(chunkArray([0], size)).toEqual([[0]]);
    const first = Array.from({ length: size }, (_, index) => index);
    const second = first.map((index) => index + size);
    const values = [...first, ...second];
    expect(chunkArray(values, size)).toEqual([first, second]);
    expect(chunkArray([...values, size * 2], size)).toEqual([first, second, [size * 2]]);
    expect(values).toEqual([...first, ...second]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid size %s", (size) => {
    expect(() => chunkArray([], size)).toThrow("positive integer chunkSize");
  });
});
