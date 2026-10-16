// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { CommsSection } from "../comms-section";

afterEach(cleanup);

describe("CommsSection", () => {

  it("does not manufacture healthy Comms state when section and dispatch telemetry are unavailable", () => {
    const data = makeHealthyStatusResponse();
    data.telegramBot = null;
    delete data.crons["dispatch-telegram-alerts"];
    data.sectionErrors.telegramBot = { code: "telegram_query_failed", message: "Telegram query unavailable" };

    render(<CommsSection data={data} />);

    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Oldest backlog").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Permanent failures")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Latest dispatch")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Telegram query unavailable")).toBeTruthy();
  });
});
