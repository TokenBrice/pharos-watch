import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Compliance client bundle boundary", () => {
  it("retains a client entrypoint for the lazy workbench", () => {
    const clientSource = readFileSync("src/app/compliance/client.tsx", "utf8");

    expect(clientSource).toMatch(/^"use client";/);
  });
});
