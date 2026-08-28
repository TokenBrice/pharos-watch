import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseOptionalRequestJsonObject,
  parseRequestJsonWithSchema,
} from "../api-json-body";

describe("parseOptionalRequestJsonObject", () => {
  it("returns an empty object when no request is provided", async () => {
    await expect(parseOptionalRequestJsonObject()).resolves.toEqual({});
  });

  it("returns an empty object for empty post bodies", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({});
  });

  it("returns the parsed object for valid JSON objects", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, limit: 10 }),
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({ dryRun: true, limit: 10 });
  });

  it("returns 400 for malformed json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 for non-object json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not-an-object"]),
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});

describe("parseRequestJsonWithSchema", () => {
  const schema = z.object({ ok: z.boolean() });

  it("returns parsed schema data for valid JSON", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });

    await expect(parseRequestJsonWithSchema(request, schema)).resolves.toEqual({ ok: true });
  });

  it("returns configured schema errors", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: "yes" }),
    });

    const response = await parseRequestJsonWithSchema(request, schema, {
      formatSchemaError: () => "Custom schema error",
      responseOptions: { noStore: true },
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "Custom schema error" });
    }
  });

  it("returns invalid JSON errors before schema validation", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: "{",
    });

    const response = await parseRequestJsonWithSchema(request, schema);
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    }
  });
});
