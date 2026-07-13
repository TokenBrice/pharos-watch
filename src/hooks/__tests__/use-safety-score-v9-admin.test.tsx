// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SafetyScoreV9AdminResponseSchema } from "@shared/types/safety-score-v9-admin";
import { CRON_24H } from "@/lib/cron-intervals";

const { useAdminPollingQueryMock } = vi.hoisted(() => ({ useAdminPollingQueryMock: vi.fn() }));

vi.mock("../use-admin-polling-query", () => ({ useAdminPollingQuery: useAdminPollingQueryMock }));

import { useSafetyScoreV9Admin } from "../use-safety-score-v9-admin";

beforeEach(() => {
  useAdminPollingQueryMock.mockReturnValue({});
});

describe("useSafetyScoreV9Admin", () => {
  it("reads the candidate through the ops proxy with strict runtime validation", () => {
    renderHook(() => useSafetyScoreV9Admin());

    expect(useAdminPollingQueryMock).toHaveBeenCalledWith(
      ["safety-score-v9-candidate"],
      API_PATHS.adminSafetyScoreV9(),
      CRON_24H,
      { schema: SafetyScoreV9AdminResponseSchema },
    );
  });
});
