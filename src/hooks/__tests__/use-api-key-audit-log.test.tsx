// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useRegisteredAdminQueryMock } = vi.hoisted(() => ({ useRegisteredAdminQueryMock: vi.fn() }));

vi.mock("../use-admin-polling-query", () => ({ useRegisteredAdminQuery: useRegisteredAdminQueryMock }));

import { useApiKeyAuditLog } from "../admin-api-hooks";

beforeEach(() => {
  useRegisteredAdminQueryMock.mockReturnValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useApiKeyAuditLog", () => {
  it("builds an explicit global latest-events query without an apiKeyId", () => {
    renderHook(() => useApiKeyAuditLog("global"));

    expect(useRegisteredAdminQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["api-key-audit-log", "global"],
        path: "/api/api-keys/audit-log?limit=50",
        enabled: true,
      }),
    );
  });

  it("preserves selected-key and disabled-null behavior", () => {
    renderHook(() => useApiKeyAuditLog(7));
    expect(useRegisteredAdminQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryKey: ["api-key-audit-log", 7],
        path: "/api/api-keys/audit-log?apiKeyId=7&limit=50",
        enabled: true,
      }),
    );

    renderHook(() => useApiKeyAuditLog(null));
    expect(useRegisteredAdminQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryKey: ["api-key-audit-log", null],
        path: "/api/api-keys/audit-log?limit=50",
        enabled: false,
      }),
    );
  });
});
