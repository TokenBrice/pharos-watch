import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const mockSendToChat = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return { ...actual, sendToChat: mockSendToChat };
});

const { disableBlockedSubscriber, drainPendingQueue, enqueuePendingAlerts, cleanupExpiredPendingAlerts, PENDING_TTL_SEC } =
  await import("../telegram-pending-queue");

beforeEach(() => {
  mockSendToChat.mockReset();
});

describe("disableBlockedSubscriber", () => {
  it("resets all alert flags including launch for both subscribers and subscriptions", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
    ]);

    const result = await disableBlockedSubscriber(db, "blocked-chat");
    expect(result).toBe(true);

    const history = db.getHistory();
    const subscriberUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(subscriberUpdate).toBeDefined();
    expect(subscriberUpdate!.sql).toContain("alert_launch=0");
    expect(subscriberUpdate!.sql).toContain("global_alert_launch=0");

    const subscriptionUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscriptions"));
    expect(subscriptionUpdate).toBeDefined();
    expect(subscriptionUpdate!.sql).toContain("alert_launch=0");
  });

  it("returns false and logs on D1 error", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [], throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await disableBlockedSubscriber(db, "bad-chat");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
