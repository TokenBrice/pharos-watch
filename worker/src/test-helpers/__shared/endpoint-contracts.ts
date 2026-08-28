import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";

export interface StablecoinParameterContractDescriptor {
  name: string;
  path: string;
  invoke: (db: D1Database, url: URL) => Promise<Response>;
  missingParameterError?: string;
  unknownStablecoin?: string;
  cases?: readonly StablecoinParameterContractCase[];
}

export type StablecoinParameterContractCase =
  | {
      kind: "missing";
      name?: string;
      error?: string;
    }
  | {
      kind: "unknown";
      name?: string;
      stablecoin?: string;
      error?: string;
      query?: string;
    };

export interface UnauthorizedEndpointContractDescriptor {
  name: string;
  invoke: () => Promise<Response>;
  status?: number | readonly number[];
  body?: unknown;
}

export function registerStablecoinParameterContract(
  descriptor: StablecoinParameterContractDescriptor,
): void {
  const requestedCases = descriptor.cases ?? [
    { kind: "missing", error: descriptor.missingParameterError },
    { kind: "unknown", stablecoin: descriptor.unknownStablecoin },
  ];
  const cases = requestedCases.map((contractCase) => contractCase.kind === "missing"
    ? {
        name: contractCase.name ?? "returns 400 when the stablecoin parameter is missing",
        url: `https://x${descriptor.path}`,
        status: 400,
        body: { error: contractCase.error ?? descriptor.missingParameterError ?? "Missing ?stablecoin= parameter" },
      }
    : {
        name: contractCase.name ?? "returns 404 when the stablecoin is unknown",
        url: `https://x${descriptor.path}?stablecoin=${encodeURIComponent(contractCase.stablecoin ?? descriptor.unknownStablecoin ?? "unknown-fixture")}${contractCase.query ? `&${contractCase.query}` : ""}`,
        status: 404,
        body: { error: contractCase.error ?? "Unknown stablecoin" },
      });

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

export function registerUnauthorizedEndpointContract(
  descriptor: UnauthorizedEndpointContractDescriptor,
): void {
  describe(`${descriptor.name} authorization contract`, () => {
    it("requires admin auth", async () => {
      const response = await descriptor.invoke();
      const expectedStatuses = typeof descriptor.status === "number"
        ? [descriptor.status]
        : descriptor.status ?? [401];

      expect(expectedStatuses).toContain(response.status);
      if (descriptor.body !== undefined) {
        expect(await response.json()).toEqual(descriptor.body);
      }
    });
  });
}
