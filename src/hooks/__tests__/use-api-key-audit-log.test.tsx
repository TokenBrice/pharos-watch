// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useAdminPollingQueryMock } = vi.hoisted(() => ({ useAdminPollingQueryMock: vi.fn() }));

vi.mock("../use-admin-polling-query", () => ({ useAdminPollingQuery: useAdminPollingQueryMock }));

import { buildApiKeyAuditLogPath, useApiKeyAuditLog } from "../use-api-key-audit-log";

beforeEach(() => {
  useAdminPollingQueryMock.mockReturnValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useApiKeyAuditLog", () => {
  it("builds an explicit global latest-events query without an apiKeyId", () => {
    expect(buildApiKeyAuditLogPath("global")).toBe("/api/api-keys/audit-log?limit=50");
    renderHook(() => useApiKeyAuditLog("global"));

    expect(useAdminPollingQueryMock).toHaveBeenCalledWith(
      ["api-key-audit-log", "global"],
      "/api/api-keys/audit-log?limit=50",
      expect.any(Number),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("preserves selected-key and disabled-null behavior", () => {
    expect(buildApiKeyAuditLogPath(7)).toBe("/api/api-keys/audit-log?apiKeyId=7&limit=50");
    renderHook(() => useApiKeyAuditLog(7));
    expect(useAdminPollingQueryMock).toHaveBeenLastCalledWith(
      ["api-key-audit-log", 7],
      "/api/api-keys/audit-log?apiKeyId=7&limit=50",
      expect.any(Number),
      expect.objectContaining({ enabled: true }),
    );

    renderHook(() => useApiKeyAuditLog(null));
    expect(useAdminPollingQueryMock).toHaveBeenLastCalledWith(
      ["api-key-audit-log", null],
      "/api/api-keys/audit-log?limit=50",
      expect.any(Number),
      expect.objectContaining({ enabled: false }),
    );
  });
});
