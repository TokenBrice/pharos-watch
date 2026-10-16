// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  GENERATED_AT,
  getApiKeyAuditLogMock,
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
