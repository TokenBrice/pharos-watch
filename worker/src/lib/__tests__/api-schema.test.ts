import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validatePayloadWithSchema } from "../api-schema";

describe("validatePayloadWithSchema", () => {
  it("returns parsed data when schema matches", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: true }, "test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ ok: true });
  });

  it("returns issues when schema fails", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: "yes" }, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});
