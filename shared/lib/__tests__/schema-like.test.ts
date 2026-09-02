import { describe, expect, it } from "vitest";
import { formatSchemaLikeIssues } from "../schema-like";

describe("formatSchemaLikeIssues", () => {
  it("formats numeric path segments and an empty root path", () => {
    expect(formatSchemaLikeIssues([
      { path: ["tokens", 2, "price"], message: "Expected number" },
      { path: [], message: "Invalid input" },
    ])).toBe("tokens.2.price: Expected number, : Invalid input");
  });
});
