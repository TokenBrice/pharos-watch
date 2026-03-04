import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAlerts, sendAlert } from "../alerts";

describe("sendAlert", () => {
  beforeEach(() => {
    initAlerts("https://hooks.slack.com/services/test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    initAlerts(undefined);
  });

  it("returns false and logs when webhook responds with non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("server exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendAlert("Cron failure", "Something failed");

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[alerts] Webhook rejected alert "Cron failure" (status 500): server exploded'),
    );
  });

  it("returns true on 2xx webhook response", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await sendAlert("Circuit closed", "Recovered");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false on fetch error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendAlert("Data stale", "Cache too old");

    expect(ok).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith("[alerts] Failed to send webhook:", expect.any(Error));
  });
});
