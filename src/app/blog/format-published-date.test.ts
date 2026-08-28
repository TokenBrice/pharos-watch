import { describe, expect, it } from "vitest";
import { formatPublishedDate } from "./format-published-date";

describe("formatPublishedDate", () => {
  it("formats the publication day in UTC", () => {
    expect(formatPublishedDate("2026-08-28")).toBe("August 28, 2026");
  });
});
