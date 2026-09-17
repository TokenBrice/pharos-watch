import { describe, expect, it } from "vitest";
import { getLogoSrc, logosById } from "@/lib/logos";

describe("logo lookup", () => {
  it.each(["constructor", "toString"])("rejects inherited key %s", (id) => {
    expect(getLogoSrc(logosById, id)).toBeUndefined();
  });
});
