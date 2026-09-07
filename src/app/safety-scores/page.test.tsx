// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SafetyScoresPage from "./page";
import { NightSetupStrip } from "../pharoswatchbot/night-setup-strip";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

describe("SafetyScoresPage", () => {
  it("links alert setup to the rendered Telegram setup section", () => {
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(<SafetyScoresPage />);
    const link = [...page.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Set up alerts"));
    expect(link).toBeDefined();
    const target = new URL(link!.getAttribute("href")!, "https://pharos.watch");
    expect(target.pathname).toBe("/pharoswatchbot");
    expect(target.hash).not.toBe("");

    const setup = document.createElement("div");
    setup.innerHTML = renderToStaticMarkup(<NightSetupStrip />);
    expect(setup.querySelector(target.hash)).not.toBeNull();
  });
});
