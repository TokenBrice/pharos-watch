// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { GradeBadge } from "@/components/grade-badge";

afterEach(cleanup);

describe("GradeBadge", () => {
  it("renders the grade text for A+", () => {
    render(<GradeBadge grade="A+" score={95} />);
    expect(screen.getByText(/A\+/)).toBeTruthy();
  });

  it("shows score when score is not null", () => {
    render(<GradeBadge grade="B" score={72} />);
    expect(screen.getByText("(72)")).toBeTruthy();
  });

  it("does not show score when score is null", () => {
    render(<GradeBadge grade="NR" score={null} />);
    expect(screen.queryByText(/\(/)).toBeNull();
  });

  it("renders aria-label including grade and score", () => {
    render(<GradeBadge grade="C" score={50} />);
    const labelledEl = document.querySelector("[aria-label]");
    expect(labelledEl?.getAttribute("aria-label")).toContain("C");
    expect(labelledEl?.getAttribute("aria-label")).toContain("50");
  });

  it("renders F grade", () => {
    render(<GradeBadge grade="F" score={20} />);
    expect(screen.getByText("F")).toBeTruthy();
  });

  it("renders NR grade without score", () => {
    render(<GradeBadge grade="NR" score={null} />);
    expect(screen.getByText("NR")).toBeTruthy();
  });

  it("applies lg size classes when size is lg", () => {
    render(<GradeBadge grade="A" score={88} size="lg" />);
    const el = document.querySelector(".text-2xl");
    expect(el).not.toBeNull();
  });

  it("applies sm size classes by default", () => {
    render(<GradeBadge grade="A" score={88} />);
    const el = document.querySelector(".text-xs");
    expect(el).not.toBeNull();
  });
});
