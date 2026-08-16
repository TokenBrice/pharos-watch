import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "./mock-d1";

export interface StablecoinParameterContractDescriptor {
  name: string;
  path: string;
  invoke: (db: D1Database, url: URL) => Promise<Response>;
  missingParameterError?: string;
  unknownStablecoin?: string;
}

export function registerStablecoinParameterContract(
  descriptor: StablecoinParameterContractDescriptor,
): void {
  const cases = [
    {
      name: "returns 400 when the stablecoin parameter is missing",
      url: `https://x${descriptor.path}`,
      status: 400,
      body: { error: descriptor.missingParameterError ?? "Missing ?stablecoin= parameter" },
    },
    {
      name: "returns 404 when the stablecoin is unknown",
      url: `https://x${descriptor.path}?stablecoin=${encodeURIComponent(descriptor.unknownStablecoin ?? "unknown-fixture")}`,
      status: 404,
      body: { error: "Unknown stablecoin" },
    },
  ] as const;

  describe(`${descriptor.name} stablecoin parameter contract`, () => {
    it.each(cases)("$name", async ({ url, status, body }) => {
      const db: MockD1Database = mockD1([]);
      const response = await descriptor.invoke(db, new URL(url));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(db.getHistory()).toEqual([]);
    });
  });
}
