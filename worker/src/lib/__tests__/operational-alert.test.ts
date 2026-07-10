import { beforeEach, describe, expect, it, vi } from "vitest";

const reportAlertCondition = vi.fn(async () => ({ state: "active" }));
const sendAlert = vi.fn(async () => true);

vi.mock("../alert-broker", () => ({ reportAlertCondition }));
vi.mock("../alerts", () => ({ sendAlert }));

const { deliverOperationalAlert } = await import("../operational-alert");

describe("deliverOperationalAlert", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists scheduled conditions through the broker", async () => {
    await expect(deliverOperationalAlert({
      db: {} as D1Database,
      conditionKey: "cron:stale",
      active: true,
      severity: "critical",
      title: "Cron stale",
      message: "lag",
      brokerMode: "shadow",
      webhookUrl: null,
    })).resolves.toBe(true);

    expect(reportAlertCondition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      conditionKey: "cron:stale",
      active: true,
      mode: "shadow",
    }));
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("keeps the legacy transport only when no broker mode is supplied", async () => {
    await expect(deliverOperationalAlert({
      db: {} as D1Database,
      conditionKey: "legacy",
      active: true,
      severity: "warning",
      title: "Legacy",
      message: "detail",
      webhookUrl: "https://hooks.example/test",
    })).resolves.toBe(true);

    expect(sendAlert).toHaveBeenCalledWith("https://hooks.example/test", "Legacy", "detail");
    expect(reportAlertCondition).not.toHaveBeenCalled();
  });
});
