import { describe, expect, it } from "vitest";
import { escapeCapabilityReviewTableCell } from "../maintenance/generate-capability-review";

describe("generate-capability-review", () => {
  it("escapes backslashes before Markdown table pipes", () => {
    expect(escapeCapabilityReviewTableCell(String.raw`path\|raw|next
line`)).toBe(String.raw`path\\\|raw\|next line`);
  });
});
