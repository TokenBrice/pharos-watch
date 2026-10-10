// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { cleanupFrontendTest, resetBrowserStorage } from "@/test-utils/frontend";

function ModePage() {
  return <>
    <MethodologyModeToggle />
    <MethodologyModeToggle />
    <details data-methodology-details="true"><summary>Technical detail</summary>Evidence</details>
    <details data-methodology-worked-example="true"><summary>Worked example</summary>Calculation</details>
  </>;
}

function expectMode(mode: "reader" | "analyst") {
  for (const button of screen.getAllByRole("button", { name: "Reader" })) {
    expect(button.getAttribute("aria-pressed")).toBe(String(mode === "reader"));
  }
  for (const button of screen.getAllByRole("button", { name: "Analyst" })) {
    expect(button.getAttribute("aria-pressed")).toBe(String(mode === "analyst"));
  }
  for (const detail of document.querySelectorAll("details")) expect(detail.open).toBe(mode === "analyst");
}

beforeEach(resetBrowserStorage);
afterEach(() => {
  cleanupFrontendTest();
  resetBrowserStorage();
});

describe("MethodologyModeToggle", () => {
  it("synchronizes both controls, storage, and details when switching Analyst then Reader", () => {
    render(<ModePage />);
    expectMode("reader");
    fireEvent.click(screen.getAllByRole("button", { name: "Analyst" })[0]);
    expectMode("analyst");
    expect(localStorage.getItem("pharos.methodology.mode")).toBe("analyst");
    fireEvent.click(screen.getAllByRole("button", { name: "Reader" })[1]);
    expectMode("reader");
    expect(localStorage.getItem("pharos.methodology.mode")).toBe("reader");
  });

  it("hydrates persisted Analyst without mismatching Reader server markup", async () => {
    localStorage.setItem("pharos.methodology.mode", "analyst");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ModePage />);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error");
    let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <ModePage />, { onRecoverableError }); });
      expectMode("analyst");
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      consoleError.mockRestore();
    }
  });
});
