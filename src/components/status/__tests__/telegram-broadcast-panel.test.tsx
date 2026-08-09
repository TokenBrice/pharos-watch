// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { adminMutationMock } = vi.hoisted(() => ({
  adminMutationMock: vi.fn(),
}));

vi.mock("@/lib/admin-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-access")>("@/lib/admin-access");
  return { ...actual, adminMutation: adminMutationMock };
});

const { TelegramBroadcastPanel } = await import("../telegram-broadcast-panel");

function okResult(data: unknown) {
  return {
    data,
    text: JSON.stringify(data),
    formattedBody: JSON.stringify(data, null, 2),
    status: 200,
    idempotencyKey: "key-1",
    idempotentReplay: false,
    executionCertainty: "confirmed",
    warning: null,
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function typeMessage(value = "<b>Maintenance</b>") {
  fireEvent.change(screen.getByLabelText("Message (Telegram HTML)"), { target: { value } });
}

afterEach(() => {
  cleanup();
  adminMutationMock.mockReset();
});

describe("TelegramBroadcastPanel", () => {
  it("keeps both actions disabled until the message and a confirmed preview exist", () => {
    render(<TelegramBroadcastPanel />);

    expect(button("Preview (dry run)").disabled).toBe(true);
    expect(button("Send live broadcast").disabled).toBe(true);

    typeMessage();
    expect(button("Preview (dry run)").disabled).toBe(false);
    // Live stays blocked: no preview has run and no canary chat id is set.
    expect(button("Send live broadcast").disabled).toBe(true);
  });

  it("previews with dryRun true and then sends live with the canary chat id", async () => {
    adminMutationMock.mockResolvedValue(okResult({ targetChatCount: 12, chunkCount: 1 }));
    render(<TelegramBroadcastPanel />);

    typeMessage();
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "global-subscribers" } });
    fireEvent.change(screen.getByLabelText("Canary chat ID (private chat)"), { target: { value: "123456789" } });
    fireEvent.click(button("Preview (dry run)"));

    await waitFor(() => expect(adminMutationMock).toHaveBeenCalledTimes(1));
    expect(adminMutationMock.mock.calls[0]?.[0]).toBe("/api/admin-telegram-broadcast");
    expect(adminMutationMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: {
        messageHtml: "<b>Maintenance</b>",
        scope: "global-subscribers",
        dryRun: true,
        canaryChatId: "123456789",
      },
    });
    expect(adminMutationMock.mock.calls[0]?.[1]?.idempotencyKey).toBeTruthy();

    await waitFor(() => expect(button("Send live broadcast").disabled).toBe(false));

    adminMutationMock.mockResolvedValue(okResult({ enqueued: 12 }));
    fireEvent.click(button("Send live broadcast"));

    await waitFor(() => expect(adminMutationMock).toHaveBeenCalledTimes(2));
    expect(adminMutationMock.mock.calls[1]?.[1]).toMatchObject({ body: { dryRun: false, canaryChatId: "123456789" } });
    // The live send is a distinct idempotency intent from the preview.
    expect(adminMutationMock.mock.calls[1]?.[1]?.idempotencyKey).not.toBe(
      adminMutationMock.mock.calls[0]?.[1]?.idempotencyKey,
    );
  });

  it("omits canaryChatId from the body when the operator left it blank", async () => {
    adminMutationMock.mockResolvedValue(okResult({ targetChatCount: 3 }));
    render(<TelegramBroadcastPanel />);

    typeMessage();
    fireEvent.click(button("Preview (dry run)"));

    await waitFor(() => expect(adminMutationMock).toHaveBeenCalledTimes(1));
    expect(adminMutationMock.mock.calls[0]?.[1]?.body).not.toHaveProperty("canaryChatId");
  });
});
