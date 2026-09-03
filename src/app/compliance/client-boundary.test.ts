import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Compliance client bundle boundary", () => {
  it("enters through a client component before dynamically loading the workbench", () => {
    const pageSource = readFileSync("src/app/compliance/page.tsx", "utf8");
    const clientSource = readFileSync("src/app/compliance/client.tsx", "utf8");

    expect(pageSource).toContain('import("./client")');
    expect(clientSource).toMatch(/^"use client";/);
    expect(clientSource).toContain('dynamic(\n  () => import("@/components/compliance/compliance-client")');
  });
});
