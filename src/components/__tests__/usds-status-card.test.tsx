// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsdsStatusCard } from "@/components/usds-status-card";

const { useUsdsStatusMock } = vi.hoisted(() => ({
  useUsdsStatusMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useUsdsStatus: useUsdsStatusMock,
}));

describe("UsdsStatusCard", () => {
  beforeEach(() => {
    useUsdsStatusMock.mockReset();
  });

  it("renders an unavailable label when lastChecked falls back to the schema sentinel", () => {
    useUsdsStatusMock.mockReturnValue({
      data: {
        freezeCapabilityPresent: false,
        implementationAddress: "0x1923dfee706a8e78157416c29cbccfde7cdf4102",
        lastChecked: 0,
      },
      isLoading: false,
    });

    render(<UsdsStatusCard />);

    expect(screen.getByText("Last checked unavailable")).toBeTruthy();
    expect(screen.getByText("Not Detected")).toBeTruthy();
  });
});
