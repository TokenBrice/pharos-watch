import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";

const { logWorkerEventArgsMock } = vi.hoisted(() => ({ logWorkerEventArgsMock: vi.fn() }));

vi.mock("../../lib/structured-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/structured-log")>()),
  logWorkerEventArgs: logWorkerEventArgsMock,
}));

import { handleDepegEvents } from "../depeg-events";

describe("/api/depeg-events refused-row logging", () => {
  beforeEach(() => {
    logWorkerEventArgsMock.mockReset();
  });

  it("logs the refused row id and reason before returning the named 503", async () => {
    const badRow = { ...makeDepegRow({ id: 2 }), direction: "sideways" };
    const db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
      { match: "pharos:depeg-events:count", rows: [{ total: 2 }] },
      { match: "depeg_events", rows: [makeDepegRow({ id: 1 }), badRow] },
    ]);

    const response = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));

    expect(response.status).toBe(503);
    expect(logWorkerEventArgsMock).toHaveBeenCalledWith(
      "api",
      "error",
      expect.stringContaining("depeg-events"),
      { eventId: 2, reason: "invalid-direction" },
    );
  });
});
