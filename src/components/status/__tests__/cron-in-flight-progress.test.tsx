// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CronInFlightProgress } from "../cron-in-flight-progress";

describe("CronInFlightProgress", () => {

  it("renders an accessible progress bar with the correct ratio", () => {
    render(<CronInFlightProgress itemsDone={50} itemsTotal={200} stale={false} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuemax")).toBe("200");
  });

  // audit: s083-src/B5 — the intended zero-total accessibility contract is
  // policy-deferred (PLAN §7); assert the determinate output the source emits
  // today rather than claiming indeterminate semantics.
  it("reports a zero-total run as determinate zero-of-zero progress", () => {
    render(<CronInFlightProgress itemsDone={0} itemsTotal={0} stale={false} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("0");
    expect(bar.getAttribute("aria-label")).toBe("Cron progress: 0 of 0");
  });

  it("clamps counts that fall outside the reported total", () => {
    const { rerender } = render(<CronInFlightProgress itemsDone={250} itemsTotal={200} stale={false} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("200");
    expect(screen.getByRole("progressbar").firstElementChild?.getAttribute("style")).toContain("width: 100%");

    rerender(<CronInFlightProgress itemsDone={-5} itemsTotal={-200} stale={false} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("0");
    expect(bar.getAttribute("aria-label")).toBe("Cron progress: 0 of 0");
    expect(bar.firstElementChild?.getAttribute("style")).toContain("width: 0%");
  });

  it("applies stale tone when stale=true", () => {
    render(<CronInFlightProgress itemsDone={50} itemsTotal={200} stale={true} />);
    expect(screen.getByRole("progressbar").getAttribute("data-stale")).toBe("true");
  });
});
