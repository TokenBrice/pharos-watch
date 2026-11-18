// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareButton } from "@/components/share-button";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { trackEvent } from "@/lib/analytics";
import { getSiteSessionGate } from "@/lib/site-session-gate";
import { SITE_SESSION_HINT_HEADER } from "@shared/lib/site-session-constants";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/site-session-gate", () => ({ SITE_SESSION_CHECK_ENABLED: true, getSiteSessionGate: vi.fn() }));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function select(name: string) {
  return act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

function retainedLinks(digit = "a") {
  const base = `https://pharos.watch/share/scorecard/${digit.repeat(64)}`;
  return { url: `${base}/`, imageUrl: `${base}.png` };
}

function mockEdition(body = retainedLinks()) {
  return mockFetch([{ match: "/_site-data/scorecard", body }], { requireMatch: true });
}

function mockCopy() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

describe("ShareButton", () => {
  const createObjectURL = vi.fn(() => "blob:pharos-png");
  const revokeObjectURL = vi.fn();
  const originalLocation = window.location.href;
  class TestClipboardItem {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  }
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(trackEvent).mockClear();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", "true");
    vi.mocked(getSiteSessionGate).mockReset();
    vi.useFakeTimers();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    const image = document.createElement("meta");
    image.setAttribute("property", "og:image");
    image.content = `https://pharos.watch/og/v2/${"d".repeat(64)}.png`;
    image.dataset.shareTest = "true";
    document.head.append(image);
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    document.head.querySelectorAll("[data-share-test]").forEach((element) => element.remove());
    window.history.replaceState(null, "", originalLocation);
  });

  it.each([false, true])("downloads the evergreen PNG and defers object URL revocation (dossier=%s)", async (dossier) => {
    const hash = "d".repeat(64);
    if (dossier) document.head.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content =
      `https://api.pharos.watch/api/og/v2/dossier/usdc-circle?fallback=${hash}`;
    const blob = new Blob(["png"], { type: "image/png" });
    const response = new Response();
    vi.spyOn(response, "blob").mockResolvedValue(blob);
    const fetchMock = mockFetch([{
      match: "/og/v2/",
      outcomes: [{ response }],
    }], { requireMatch: true });

    render(<ShareButton stablecoinId={dossier ? "usdc-circle" : undefined} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download PNG" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/og/v2/${dossier ? "image-" : ""}${hash}.png`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-png");
  });

  it.each(["Download PNG", "Copy as image"])("keeps %s loading past prior link feedback", async (action) => {
    const response = Promise.withResolvers<Response>();
    const write = vi.fn(async (items: TestClipboardItem[]) => {
      await items[0]!.data["image/png"];
    });
    vi.stubGlobal("navigator", { clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined), write,
    } });
    mockFetch([{ match: "/og/v2/", respond: () => response.promise }], { requireMatch: true });
    render(<ShareButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(screen.getByRole("button", { name: "Copied!" })).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: action }));
      if (action === "Copy as image") expect(write).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole("button", { name: "Share" })).toHaveProperty("disabled", true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("button", { name: "Share" })).toHaveProperty("disabled", true);
    await act(async () => { response.resolve(new Response("png")); });
    const completedLabel = action === "Copy as image" ? "Copied!" : "Share";
    expect(screen.getByRole("button", { name: completedLabel })).toHaveProperty("disabled", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(screen.getByRole("button", { name: completedLabel })).toHaveProperty("disabled", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("button", { name: "Share" })).toHaveProperty("disabled", false);
  });

  it.each(["clean", "private-state", "missing"])("strips private query and fragment state from shared links; canonical=%s", async (canonicalKind) => {
    window.history.replaceState(null, "", "/stablecoin/usdc-circle/?holdings=private&answers=secret#private-state");
    const writeText = mockCopy();
    if (canonicalKind !== "missing") {
      const canonical = document.createElement("link");
      canonical.rel = "canonical";
      canonical.href = `https://pharos.watch/stablecoin/usdc-circle/${canonicalKind === "private-state" ? "?answers=secret#private-state" : ""}`;
      canonical.dataset.shareTest = "true";
      document.head.append(canonical);
    }
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Copy link");
    expect(writeText).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle/");
  });

  it("creates and copies a retained edition using only stablecoin identity", async () => {
    const { url, imageUrl } = retainedLinks();
    const writeText = mockCopy();
    const fetchMock = mockEdition();
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    expect(fetchMock.getHistory()).toMatchObject([{ method: "POST", body: JSON.stringify({ stablecoinId: "usdc-circle" }) }]);
    expect(writeText).toHaveBeenCalledWith(url);
    expect(trackEvent).toHaveBeenCalledWith("social_share", { action: "dated_scorecard", outcome: "success", surface: "stablecoin" });
    expect(screen.getByRole("link", { name: "Open dated scorecard" }).getAttribute("href")).toBe(url);
    expect(screen.getByRole("link", { name: "Download dated PNG" }).getAttribute("href")).toBe(imageUrl);
  });

  it("opens the dated briefing from the depeg share menu", () => {
    const url = "https://api.pharos.watch/api/og/v2/depeg/briefing";
    render(<ShareButton depegBriefingUrl={url} />);
    expect(screen.getByRole("link", { name: "Open dated depeg briefing" }).getAttribute("href")).toBe(url);
  });

  it("offers no dated scorecard for a coin without a published grade", () => {
    render(<ShareButton stablecoinId="usdc-circle" datedScorecard={false} />);
    expect(screen.queryByRole("button", { name: "Share dated scorecard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download PNG" })).toBeTruthy();
  });

  it("leaves session acquisition disabled when the browser rollout flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK", "false");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
    mockCopy();
    const fetchMock = mockEdition();
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getSiteSessionGate).not.toHaveBeenCalled();
  });

  it("waits for the shared browser session before creating a dated edition", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
    const ready = Promise.withResolvers<void>();
    const session = {
      hasValidSiteSession: vi.fn(() => false),
      invalidateSiteSession: vi.fn(),
      waitForSiteSession: vi.fn(() => ready.promise),
    };
    vi.mocked(getSiteSessionGate).mockReturnValue(session);
    const writeText = mockCopy();
    const { url } = retainedLinks();
    const fetchMock = mockEdition();
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    expect(session.waitForSiteSession).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Share" })).toHaveProperty("disabled", true);
    await act(async () => { ready.resolve(); });
    expect(fetchMock.getHistory()).toMatchObject([{ method: "POST", body: JSON.stringify({ stablecoinId: "usdc-circle" }) }]);
    expect(fetchMock).toHaveBeenCalledWith("/_site-data/scorecard", expect.objectContaining({ credentials: "same-origin" }));
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it.each(["cancel", "unmount", "supersede"])("suppresses creation after %s while awaiting the shared session", async (action) => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
    const ready = Promise.withResolvers<void>();
    vi.mocked(getSiteSessionGate).mockReturnValue({
      hasValidSiteSession: () => false, invalidateSiteSession: vi.fn(), waitForSiteSession: () => ready.promise,
    });
    const writeText = mockCopy();
    const fetchMock = mockFetch([], { requireMatch: true });
    const view = render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    await act(async () => {
      if (action === "unmount") view.unmount();
      else {
        fireEvent.click(screen.getByRole("button", { name: "Cancel sharing" }));
        if (action === "supersede") fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      }
    });
    await act(async () => { ready.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open dated scorecard" })).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(action === "supersede" ? 1 : 0);
  });

  it.each(["success", "required", "unauthorized"])("renews only session-hinted rejections, outcome=%s", async (outcome) => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
    const session = {
      hasValidSiteSession: vi.fn(() => true), invalidateSiteSession: vi.fn(), waitForSiteSession: vi.fn(async () => {}),
    };
    vi.mocked(getSiteSessionGate).mockReturnValue(session);
    const writeText = mockCopy();
    const fetchMock = mockFetch([{
      match: "/_site-data/scorecard",
      outcomes: [
        { response: new Response("{}", { status: 401, headers: outcome === "unauthorized" ? {} : { [SITE_SESSION_HINT_HEADER]: "required" } }) },
        { response: outcome === "success"
          ? Response.json(retainedLinks())
          : new Response("{}", { status: 401, headers: { [SITE_SESSION_HINT_HEADER]: "required" } }) },
      ],
    }], { requireMatch: true });
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    expect(fetchMock).toHaveBeenCalledTimes(outcome === "unauthorized" ? 1 : 2);
    expect(session.waitForSiteSession).toHaveBeenCalledTimes(outcome === "unauthorized" ? 0 : 1);
    expect(session.invalidateSiteSession).toHaveBeenCalledTimes(outcome === "unauthorized" ? 0 : outcome === "success" ? 1 : 2);
    expect(writeText).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    if (outcome !== "success") expect(screen.getByRole("alert").textContent).toContain("Could not create a dated scorecard");
  });

  it("retains manual-copy and PNG access when the clipboard is blocked", async () => {
    const links = retainedLinks("b");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    mockEdition(links);
    render(<ShareButton stablecoinId="safety-scores" />);
    await select("Share dated scorecard");
    expect(screen.getByRole("textbox", { name: "Share link" })).toHaveProperty("value", links.url);
    expect(screen.getByRole("alert").textContent).toContain("Scorecard created");
    expect(screen.getByRole("link", { name: "Download dated PNG" })).toBeTruthy();
  });

  it.each(["cancel", "unmount"])("suppresses late dated-share results after %s", async (action) => {
    const pending = Promise.withResolvers<Response>();
    const writeText = mockCopy();
    mockFetch([{ match: "/_site-data/scorecard", respond: () => pending.promise }], { requireMatch: true });
    const view = render(<ShareButton stablecoinId="safety-scores" />);
    await select("Share dated scorecard");
    await act(async () => {
      if (action === "unmount") view.unmount();
      else fireEvent.click(screen.getByRole("button", { name: "Cancel sharing" }));
    });
    await act(async () => { pending.resolve(Response.json(retainedLinks("c"))); });
    expect(trackEvent).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Open dated scorecard" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports upstream admission failures instead of copying a live fallback", async () => {
    const writeText = mockCopy();
    mockFetch([{ match: "/_site-data/scorecard", status: 503, body: { error: "held" } }], { requireMatch: true });
    render(<ShareButton stablecoinId="safety-scores" />);
    await select("Share dated scorecard");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Could not create a dated scorecard");
    expect(trackEvent).toHaveBeenCalledWith("social_share", { action: "dated_scorecard", outcome: "error", surface: "safety-scores" });
    expect(screen.queryByRole("link", { name: "Open dated scorecard" })).toBeNull();
  });

  it.each(["missing", "external", "legacy"])("rejects %s preview metadata without fetching a numeric fallback", async (kind) => {
    const image = document.head.querySelector<HTMLMetaElement>('meta[property="og:image"]')!;
    if (kind === "missing") image.remove();
    else image.content = kind === "external" ? "https://example.com/og/v2/image.png" : "https://pharos.watch/og-stablecoin.png";
    const fetchMock = mockFetch([], { requireMatch: true });
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Download PNG");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Could not download the PNG");
  });

  it.each(["cancel", "unmount", "supersede"])("ignores a pending clipboard rejection after %s", async (action) => {
    const pendingWrite = Promise.withResolvers<void>();
    const writingStarted = Promise.withResolvers<void>();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: {
      writeText,
      write: vi.fn(async (items: TestClipboardItem[]) => {
        await items[0]!.data["image/png"];
        writingStarted.resolve();
        await pendingWrite.promise;
      }),
    } });
    mockFetch([{ match: "/og/v2/", respond: () => new Response("png") }], { requireMatch: true });
    const view = render(<ShareButton stablecoinId="usdc-circle" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as image" }));
      await writingStarted.promise;
    });
    await act(async () => {
      if (action === "unmount") view.unmount();
      else {
        fireEvent.click(screen.getByRole("button", { name: "Cancel sharing" }));
        if (action === "supersede") fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      }
    });
    await act(async () => { pendingWrite.reject(new Error("Late clipboard rejection")); });
    expect(screen.queryByRole("alert")).toBeNull();
    if (action === "supersede") {
      expect(screen.getByRole("button", { name: "Copied!" })).toHaveProperty("disabled", false);
      expect(trackEvent).toHaveBeenCalledExactlyOnceWith("social_share", { action: "copy_link", outcome: "success", surface: "stablecoin" });
    } else expect(trackEvent).not.toHaveBeenCalled();
  });

  it.each(["external", "mismatched-image", "query", "credentials"])("refuses %s retained URLs before exposing or copying them", async (fault) => {
    const id = "f".repeat(64);
    let { url, imageUrl } = retainedLinks("f");
    if (fault === "external") url = url.replace("pharos.watch", "example.com");
    if (fault === "mismatched-image") imageUrl = imageUrl.replace(id, "e".repeat(64));
    if (fault === "query") url += "?private=value";
    if (fault === "credentials") imageUrl = imageUrl.replace("https://", "https://user@");
    const writeText = mockCopy();
    mockEdition({ url, imageUrl });
    render(<ShareButton stablecoinId="usdc-circle" />);
    await select("Share dated scorecard");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Open dated scorecard" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Could not create a dated scorecard");
  });

});
