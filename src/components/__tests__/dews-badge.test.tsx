// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DEWSBadge } from "@/components/dews-badge";


describe("DEWSBadge", () => {
  it("returns null for CALM band", () => {
    const { container } = render(<DEWSBadge score={10} band="CALM" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders WATCH band with label", () => {
    render(<DEWSBadge score={25} band="WATCH" />);
    expect(screen.getByText("Watch")).toBeTruthy();
  });

  it("renders ALERT band with label", () => {
    render(<DEWSBadge score={45} band="ALERT" />);
    expect(screen.getByText("Alert")).toBeTruthy();
  });

  it("renders WARNING band with label", () => {
    render(<DEWSBadge score={65} band="WARNING" />);
    expect(screen.getByText("Warning")).toBeTruthy();
  });

  it("renders DANGER band with label", () => {
    render(<DEWSBadge score={85} band="DANGER" />);
    expect(screen.getByText("Danger")).toBeTruthy();
  });

  it("shows compact single-letter label when compact=true", () => {
    render(<DEWSBadge score={65} band="WARNING" compact />);
    expect(screen.getByText("W")).toBeTruthy();
    expect(screen.queryByText("Warning")).toBeNull();
  });

  it("shows upward arrow when score increased from prevScore", () => {
    render(<DEWSBadge score={70} band="WARNING" prevScore={55} />);
    const el = screen.getByText(/Warning/);
    expect(el.textContent).toContain("▲");
  });

  it("does not show arrow when score equals prevScore", () => {
    render(<DEWSBadge score={65} band="WARNING" prevScore={65} />);
    const el = screen.getByText(/Warning/);
    expect(el.textContent).not.toContain("▲");
  });

  it("does not show arrow when score is lower than prevScore", () => {
    render(<DEWSBadge score={50} band="ALERT" prevScore={65} />);
    const el = screen.getByText(/Alert/);
    expect(el.textContent).not.toContain("▲");
  });

  it("sets tooltip with score info", () => {
    render(<DEWSBadge score={65} band="WARNING" />);
    const el = screen.getByText("Warning");
    expect(el.getAttribute("title")).toContain("65/100");
  });

  it("includes top signal in tooltip when signals provided", () => {
    render(
      <DEWSBadge
        score={65}
        band="WARNING"
        signals={{
          supply: { value: 80, available: true },
          velocity: { value: 40, available: true },
        }}
      />,
    );
    const el = screen.getByText("Warning");
    expect(el.getAttribute("title")).toContain("Supply Velocity");
  });

  it("ignores unavailable signals and picks from available ones", () => {
    render(
      <DEWSBadge
        score={65}
        band="WARNING"
        signals={{
          supply: { value: 80, available: false },
          velocity: { value: 40, available: true },
        }}
      />,
    );
    const el = screen.getByText("Warning");
    // Only velocity is available; supply should not be the top signal
    expect(el.getAttribute("title")).toContain("velocity");
  });
});
