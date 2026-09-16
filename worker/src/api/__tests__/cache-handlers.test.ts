import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

import { handleUsdsStatus } from "../cache-handlers";

const IMPLEMENTATION_ADDRESS = "0x1923dfee706a8e78157416c29cbccfde7cdf4102";

describe("handleUsdsStatus", () => {
  it("returns malformed 503 when freeze capability evidence is absent", async () => {
    const db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["usds-status"],
      rows: [],
      first: {
        value: JSON.stringify({
          implementationAddress: IMPLEMENTATION_ADDRESS,
          lastChecked: 1_762_000_000,
        }),
        updated_at: 1_762_000_000,
      },
    }]);

    const response = await handleUsdsStatus(db);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cached usds-status payload is malformed",
    });
  });
});
