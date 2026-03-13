"use client";

import { describe, expect, it } from "vitest";
import { parseStressSelectionFromSearch } from "../use-stress-test";

describe("parseStressSelectionFromSearch", () => {
  it("parses canonical ids from the query string", () => {
    expect(parseStressSelectionFromSearch("?stress=usdf-falcon&grade=D")).toEqual({
      coinId: "usdf-falcon",
      grade: "D",
    });
  });

  it("rejects ambiguous legacy symbols", () => {
    expect(parseStressSelectionFromSearch("?stress=usdf&grade=D")).toEqual({
      coinId: null,
      grade: null,
    });
  });
});
