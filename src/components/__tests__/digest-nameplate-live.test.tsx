// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DigestContentEntry } from "@shared/types";

const { useDailyDigestMock, useDigestArchiveMock } = vi.hoisted(() => ({
  useDailyDigestMock: vi.fn(),
  useDigestArchiveMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDailyDigest: useDailyDigestMock,
  useDigestArchive: useDigestArchiveMock,
}));

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import { DigestNameplateLive } from "@/components/digest-nameplate-live";

const seedEdition: DigestContentEntry = {
  date: "2026-08-31",
  generatedAt: Date.parse("2026-08-31T00:30:00Z") / 1000,
  digestType: "daily",
  title: "Build-time edition",
  text: "Captured edition text",
  extended: "",
  editionNumber: 42,
};

afterEach(() => {
  useDailyDigestMock.mockReset();
  useDigestArchiveMock.mockReset();
});

function mockQueries(digestData?: Record<string, unknown>) {
  useDigestArchiveMock.mockReturnValue({ data: undefined });
  useDailyDigestMock.mockReturnValue({ data: digestData });
}

describe("DigestNameplateLive", () => {
  it("keeps the build-time edition on the first render", () => {
    mockQueries();
    render(<DigestNameplateLive initialLead={seedEdition} />);

    expect(screen.getByText("Issue #42")).toBeTruthy();
    expect(screen.getByText("Monday, August 31, 2026")).toBeTruthy();
  });

  it("moves the issue number and date together to a newer live edition", () => {
    mockQueries();
    const view = render(<DigestNameplateLive initialLead={seedEdition} />);

    mockQueries({
      digest: "Live edition text",
      digestTitle: "Live edition",
      generatedAt: Date.parse("2026-09-01T00:30:00Z") / 1000,
      editionNumber: 43,
    });
    view.rerender(<DigestNameplateLive initialLead={seedEdition} />);

    expect(screen.getByText("Issue #43")).toBeTruthy();
    expect(screen.getByText("Tuesday, September 1, 2026")).toBeTruthy();
    expect(screen.queryByText("Issue #42")).toBeNull();
  });

  it("omits a null or zero issue number", () => {
    mockQueries();
    const view = render(<DigestNameplateLive initialLead={{ ...seedEdition, editionNumber: 0 }} />);

    expect(screen.queryByText(/Issue #/)).toBeNull();
    expect(screen.getByText("Monday, August 31, 2026")).toBeTruthy();

    mockQueries({
      digest: "Live edition text",
      digestTitle: "Live edition",
      generatedAt: Date.parse("2026-09-01T00:30:00Z") / 1000,
      editionNumber: null,
    });
    view.rerender(<DigestNameplateLive initialLead={{ ...seedEdition, editionNumber: 0 }} />);

    expect(screen.queryByText(/Issue #/)).toBeNull();
    expect(screen.getByText("Tuesday, September 1, 2026")).toBeTruthy();
  });
});
