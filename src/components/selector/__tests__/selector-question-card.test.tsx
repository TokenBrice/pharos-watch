// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SelectorQuestionCard } from "@/components/selector/selector-question-card";

const HORIZONS = [
  { value: "lt24h", label: "Under 24h" },
  { value: "1to7d", label: "1-7 days" },
] as const;

const USES = [
  { value: "payments", label: "Payments" },
  { value: "yield", label: "Yield" },
  { value: "all", label: "All of the above" },
] as const;

describe("SelectorQuestionCard", () => {
  it("hides the action row when showActions is false while keeping the options", () => {
    const props = {
      questionId: "q2",
      step: 2,
      totalSteps: 5,
      legend: "How long do you plan to hold this position?",
      options: HORIZONS,
      value: "lt24h",
      onChange: vi.fn(),
      onBack: vi.fn(),
      onNext: vi.fn(),
    } as const;

    const { rerender } = render(<SelectorQuestionCard {...props} showActions />);

    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();

    rerender(<SelectorQuestionCard {...props} showActions={false} />);

    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Under 24h" })).toBeTruthy();
  });

  it("reports the chosen radio value and reflects the active option", () => {
    const onChange = vi.fn();

    render(
      <SelectorQuestionCard
        questionId="q2"
        step={2}
        totalSteps={5}
        legend="Horizon"
        options={HORIZONS}
        value="lt24h"
        onChange={onChange}
      />,
    );

    const chosen = screen.getByRole("radio", { name: "Under 24h" }) as HTMLInputElement;
    const other = screen.getByRole("radio", { name: "1-7 days" }) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    expect(other.checked).toBe(false);

    fireEvent.click(other);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("1to7d");
  });

  it("accumulates and removes checkbox answers without touching other selections", () => {
    const onChange = vi.fn();
    const props = {
      questionId: "q3",
      step: 3,
      totalSteps: 5,
      legend: "What will you use it for?",
      options: USES,
      multi: true,
      onChange,
    } as const;

    const { rerender } = render(<SelectorQuestionCard {...props} value={["payments"]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Yield" }));
    expect(onChange).toHaveBeenLastCalledWith(["payments", "yield"]);

    onChange.mockClear();
    rerender(<SelectorQuestionCard {...props} value={["payments", "yield"]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Payments" }));
    expect(onChange).toHaveBeenLastCalledWith(["yield"]);
  });

  it("makes 'all' exclusive in both directions", () => {
    const onChange = vi.fn();
    const props = {
      questionId: "q3",
      step: 3,
      totalSteps: 5,
      legend: "What will you use it for?",
      options: USES,
      multi: true,
      onChange,
    } as const;

    const { rerender } = render(<SelectorQuestionCard {...props} value={["payments", "yield"]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "All of the above" }));
    expect(onChange).toHaveBeenLastCalledWith(["all"]);

    onChange.mockClear();
    rerender(<SelectorQuestionCard {...props} value={["all"]} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Payments" }));
    expect(onChange).toHaveBeenLastCalledWith(["payments"]);
  });

  it("gates progression until the answer is non-empty", () => {
    const onNext = vi.fn();
    const props = {
      questionId: "q3",
      step: 3,
      totalSteps: 3,
      legend: "What will you use it for?",
      options: USES,
      multi: true,
      onChange: vi.fn(),
      onNext,
    } as const;

    const { rerender } = render(<SelectorQuestionCard {...props} value={[]} />);

    const submit = screen.getByRole("button", { name: "See my shortlist" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(submit);
    expect(onNext).not.toHaveBeenCalled();

    rerender(<SelectorQuestionCard {...props} value={["yield"]} />);

    const enabled = screen.getByRole("button", { name: "See my shortlist" });
    expect(enabled).toHaveProperty("disabled", false);
    fireEvent.click(enabled);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("offers continue and change-profile actions only when the answer matches the confirmation trigger", () => {
    const onContinue = vi.fn();
    const onChangeProfile = vi.fn();
    const props = {
      questionId: "q4",
      step: 4,
      totalSteps: 5,
      legend: "Depeg tolerance",
      options: USES,
      multi: true,
      onChange: vi.fn(),
      softConfirmation: {
        triggerWhen: ["yield", "all"],
        message: "Yield mandates rarely fit a treasury profile.",
        onContinue,
        onChangeProfile,
      },
    } as const;

    const { rerender } = render(<SelectorQuestionCard {...props} value={["payments"]} />);

    expect(screen.queryByRole("status")).toBeNull();

    rerender(<SelectorQuestionCard {...props} value={["payments", "all"]} />);

    expect(screen.getByRole("status").textContent).toContain("rarely fit a treasury profile");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Change profile" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onChangeProfile).toHaveBeenCalledTimes(1);
  });
});
