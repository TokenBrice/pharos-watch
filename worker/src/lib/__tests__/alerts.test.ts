import { afterEach, describe, expect, it, vi } from "vitest";

import { sendAlert } from "../alerts";

const TEST_WEBHOOK = "https://hooks.slack.com/services/test";

describe("sendAlert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false and logs when webhook responds with non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("server exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendAlert(TEST_WEBHOOK, "Cron failure", "Something failed");

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[alerts] Webhook rejected alert "Cron failure" (status 500): server exploded'),
    );
  });

  it("returns true on 2xx webhook response", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await sendAlert(TEST_WEBHOOK, "Circuit closed", "Recovered");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false on fetch error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await sendAlert(TEST_WEBHOOK, "Data stale", "Cache too old");

    expect(ok).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith("[alerts] Failed to send webhook:", expect.any(Error));
  });

  it("returns false when webhook URL is null", async () => {
    const ok = await sendAlert(null, "Title", "Message");
    expect(ok).toBe(false);
  });

  it("returns false when webhook URL is undefined", async () => {
    const ok = await sendAlert(undefined, "Title", "Message");
    expect(ok).toBe(false);
  });
});
