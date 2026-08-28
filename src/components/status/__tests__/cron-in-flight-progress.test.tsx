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

  it("renders indeterminate when itemsTotal is 0", () => {
    render(<CronInFlightProgress itemsDone={0} itemsTotal={0} stale={false} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("applies stale tone when stale=true", () => {
    render(<CronInFlightProgress itemsDone={50} itemsTotal={200} stale={true} />);
    expect(screen.getByRole("progressbar").getAttribute("data-stale")).toBe("true");
  });
});
