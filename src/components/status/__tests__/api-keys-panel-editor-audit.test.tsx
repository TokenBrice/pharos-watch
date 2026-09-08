// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_AT,
  getApiKeyAuditLogMock,
  keyResponse,
  makeKey,
  renderPanel,
  setAuditLog,
} from "./api-keys-panel-harness";

describe("ApiKeysPanel editor and audit history", () => {
  it("mounts one focused selected-key editor with selected disclosure semantics and audit history", async () => {
    setAuditLog({
      data: {
        entries: [
          {
            id: 91,
            apiKeyId: 1,
            action: "rotated",
            actor: "admin",
            detail: { source: "operator" },
            createdAt: GENERATED_AT - 60,
          },
        ],
      },
    });
    renderPanel([
      makeKey(),
      makeKey({ id: 2, name: "Digest Key", keyPrefix: "digest", maskedToken: "ph_live_digest_********" }),
    ]);

    const opsEdit = screen.getByRole("button", { name: /^Edit Ops Key/ });
    expect(opsEdit.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(opsEdit);
    const opsRegion = screen.getByRole("region", { name: "Ops Key" });
    await waitFor(() => expect(document.activeElement).toBe(opsRegion));
    expect(opsEdit.getAttribute("aria-expanded")).toBe("true");
    expect(opsEdit.getAttribute("aria-controls")).toBe("api-key-detail-panel-1");
    expect(opsEdit.closest("tr")?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Audit history" })).toBeTruthy();
    expect(screen.getByText("Rotated")).toBeTruthy();
    expect(screen.getByText("Actor: admin")).toBeTruthy();

    const digestEdit = screen.getByRole("button", { name: /^Edit Digest Key/ });
    fireEvent.click(digestEdit);
    expect(screen.queryByRole("heading", { name: "Ops Key" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Digest Key" })).toBeTruthy();
    expect(screen.getAllByLabelText("Tier")).toHaveLength(1);
    expect(getApiKeyAuditLogMock()).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(document.activeElement).toBe(digestEdit));
  });

  it("returns focus to the inventory when an edit removes the selected key from the active view", async () => {
    const updatedKey = makeKey({ expiresAt: GENERATED_AT + 30 * 24 * 60 * 60 });
    vi.mocked(fetch).mockResolvedValue(keyResponse({ key: updatedKey }, { status: 200 }));
    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Ops Key" })));
    fireEvent.change(screen.getByLabelText("Expires At"), { target: { value: "2023-12-14T22:13" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes to Ops Key/ }));

    expect(await screen.findByText("Updated Ops Key.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Ops Key" })).toBeNull();
    const inventory = screen.getByRole("region", { name: "Key inventory" });
    expect(inventory.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(inventory));
  });

  it("returns focus to the inventory when an edit sorts the selected key off the current page", async () => {
    const keys = Array.from({ length: 26 }, (_, index) =>
      makeKey({
        id: index + 1,
        name: `Key ${String(index + 1).padStart(2, "0")}`,
        keyPrefix: `prefix-${index + 1}`,
        maskedToken: `ph_live_prefix-${index + 1}_********`,
      }),
    );
    const updatedKey = makeKey({
      id: 1,
      name: "ZZZ",
      keyPrefix: "prefix-1",
      maskedToken: "ph_live_prefix-1_********",
    });
    const refetch = vi.fn().mockResolvedValue({
      data: {
        generatedAt: GENERATED_AT,
        keys: [updatedKey, ...keys.slice(1)],
      },
    });
    vi.mocked(fetch).mockResolvedValue(keyResponse({ key: updatedKey }, { status: 200 }));
    renderPanel(keys, refetch);

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit Key 01/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Key 01" })));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes to Key 01/ }));

    expect(await screen.findByText("Updated ZZZ.")).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Key 01" })).toBeNull();
    const inventory = screen.getByRole("region", { name: "Key inventory" });
    await waitFor(() => expect(document.activeElement).toBe(inventory));
  });

  it("shows audit loading and unavailable states with a local retry", async () => {
    const retryAudit = setAuditLog({ error: new Error("audit store unavailable") });
    renderPanel([makeKey()]);

    fireEvent.click(screen.getByRole("button", { name: /^Edit Ops Key/ }));
    expect(screen.getByText("Audit history unavailable")).toBeTruthy();
    expect(screen.getByText("audit store unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry audit history" }));
    expect(retryAudit).toHaveBeenCalledOnce();

    cleanup();
    setAuditLog({ isLoading: true, isFetching: true });
    renderPanel([makeKey({ id: 2, name: "Loading Key" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Edit Loading Key/ }));
    expect(screen.getByText("Loading audit history...")).toBeTruthy();
  });
});
