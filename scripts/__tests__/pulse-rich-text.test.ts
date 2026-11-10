import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowlistedRichText, validateEditorialContent } from "../../.codex/skills/stablecoin-pulse-report/scripts/rich-text.mjs";

const PAYLOAD = '<img src="https://example.com/active" onerror="alert(1)">';

function pulseContent() {
  return {
    title: "Pulse", subtitle: "Fixture", window: "October", footer: "Fixture",
    period: { start: "2026-10-01", end: "2026-10-02" }, kpis: [{ label: "Supply", value: "$1", delta: "0", tone: "flat" }],
    tldr: ["Brief"], watch: ["Watch"], chartAnnotations: [],
    sections: [{ id: "movers", title: "Movers", rows: [{ asset: "USD", delta: "0", pct: "0%", why: "Reason", tone: "flat" }] },
      ...["launches", "stress", "market"].map(id => ({ id, title: id, items: ["Item"] }))],
    annex: { title: "Evidence", methodology: "Method", blocks: [{ tag: "Tag", heading: "Heading", body: "Body", sources: [{ label: "Source", url: "https://example.com" }] }] },
  };
}

describe("pulse editorial rich text", () => {
  it.each([
    '<script>alert(1)</script>', '<img src="https://example.com/x" onerror="alert(1)">',
    '<svg><a href="https://example.com">x</a></svg>', '<style>body{display:none}</style>',
    '<b onclick="alert(1)">x</b>', '<a href="javascript:alert(1)">x</a>',
    '<a href="java&#x73;cript:alert(1)">x</a>', '<a href="https://example.com" style="color:red">x</a>',
    '<iframe src="https://example.com"></iframe>', '<a href="//example.com">x</a>',
  ])("rejects active or unsupported markup: %s", (copy) => {
    expect(() => allowlistedRichText(copy, "copy")).toThrow("content.json: copy");
  });
  it("keeps escaped markup inert after parsing and serialization", () => {
    expect(allowlistedRichText('&lt;script&gt;alert(1)&lt;/script&gt;', "copy")).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it.each([
    ["tldr", "tldr[0]"],
    ["watch", "watch[0]"],
    ["mover", "sections.movers.rows[0].why"],
    ["compact", "sections.launches.items[0]"],
    ["body", "annex.blocks[0].body"],
    ["methodology", "annex.methodology"],
  ] as const)("rejects payloads at the builder's %s boundary before writing HTML", (field, position) => {
    const content = pulseContent();
    if (field === "tldr" || field === "watch") content[field][0] = PAYLOAD;
    if (field === "mover") {
      const section = content.sections[0];
      expect(section).toBeDefined();
      if (!section || !("rows" in section)) throw new Error("Expected a movers section");
      section.rows[0]!.why = PAYLOAD;
    }
    if (field === "compact") {
      const section = content.sections[1];
      expect(section).toBeDefined();
      if (!section || !("items" in section)) throw new Error("Expected a compact section");
      section.items[0] = PAYLOAD;
    }
    if (field === "body") content.annex.blocks[0]!.body = PAYLOAD;
    if (field === "methodology") content.annex.methodology = PAYLOAD;
    expect(() => validateEditorialContent(content)).toThrow(`content.json: ${position} contains unsupported rich-text markup`);
  });
  it("exits non-zero without writing HTML when the CLI boundary rejects a payload", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pulse-rich-"));
    const content = pulseContent();
    content.annex.blocks[0]!.body = PAYLOAD;
    try {
      writeFileSync(path.join(dir, "content.json"), JSON.stringify(content));
      let failure: unknown;
      try { execFileSync(process.execPath, [".codex/skills/stablecoin-pulse-report/scripts/build-pulse-pdf.mjs", "--dir", dir], { stdio: "pipe" }); }
      catch (error) { failure = error; }
      expect((failure as { status?: number } | undefined)?.status).toBeGreaterThan(0);
      expect(String((failure as { stderr: Buffer })?.stderr)).toContain("unsupported rich-text markup");
      expect(existsSync(path.join(dir, "out/report.html"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
