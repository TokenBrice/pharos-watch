// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
} from "@shared/lib/telegram-mini-app-contract";
import type { TelegramMiniAppPortabilityResponse } from "../types";
import { makeMiniAppState } from "../mini-app-test-fixtures";
import { WatchlistPortabilityPanel } from "./WatchlistPortabilityPanel";

const staleState = makeMiniAppState({
  viewer: { canMutate: false, mutationBlockReason: "stale-auth" },
  subscriptions: [],
  catalog: {
    recommendedPresets: [],
    searchableCoins: [{ stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
  },
});

const writableState = makeMiniAppState({
  presets: [{ id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: false, safety: false }, depegStepBps: null }],
  catalog: {
    recommendedPresets: [],
    searchableCoins: [{ stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
  },
});

const exportResponse: TelegramMiniAppPortabilityResponse = {
  contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
  catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
  result: { kind: "watchlist-export", token: "pw2.payload.digest", directCount: 1, presetCount: 0 },
};

function importPreview(overrides: Partial<Extract<TelegramMiniAppPortabilityResponse["result"], { kind: "watchlist-import-preview" }>> = {}): TelegramMiniAppPortabilityResponse {
  return {
    contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    result: {
      kind: "watchlist-import-preview",
      expectedPreferenceGeneration: 2,
      previewFingerprint: "preview-v1-12-deadbeef",
      preview: {
        directAdds: [], directRemoves: [], directChanges: [],
        presetAdds: [], presetRemoves: [], presetChanges: [],
        directBroadenedCoverage: [], directRemovedCoverage: [],
        presetBroadenedCoverage: [], presetRemovedCoverage: [],
      },
      ...overrides,
    },
  };
}

type PanelProps = ComponentProps<typeof WatchlistPortabilityPanel>;

function renderPanel(overrides: Partial<PanelProps> = {}): void {
  render(
    <WatchlistPortabilityPanel
      state={staleState}
      canMutate={false}
      canReadPortability
      isMutating={false}
      pendingOperation={null}
      onExport={vi.fn().mockResolvedValue(exportResponse)}
      onPreview={vi.fn()}
      onConfirm={vi.fn()}
      {...overrides}
    />,
  );
}

function enterImportToken(token: string): void {
  fireEvent.change(screen.getByLabelText("Import a portable token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WatchlistPortabilityPanel", () => {
  it("keeps signed export and preview available while stale auth disables confirmation", async () => {
    const onExport = vi.fn().mockResolvedValue(exportResponse);
    const onPreview = vi.fn().mockResolvedValue(importPreview());

    renderPanel({ onExport, onPreview });

    const exportButton = screen.getByRole("button", { name: "Export watchlist" });
    expect(exportButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(exportButton);
    await waitFor(() => expect(onExport).toHaveBeenCalledOnce());

    const input = screen.getByLabelText("Import a portable token");
    expect(input.hasAttribute("disabled")).toBe(false);
    enterImportToken("pw2.payload.digest");
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("pw2.payload.digest"));
    await screen.findByText("Exact replacement preview");
    expect(screen.getByRole("button", { name: "Apply exact replacement" }).hasAttribute("disabled")).toBe(true);
  });

  it("applies an exact replacement with the previewed token identity and clears the form on success", async () => {
    const onConfirm = vi.fn().mockResolvedValue({});
    renderPanel({ state: writableState, canMutate: true, onPreview: vi.fn().mockResolvedValue(importPreview()), onConfirm });

    enterImportToken("pw2.import.token");
    await screen.findByText("Exact replacement preview");
    fireEvent.click(screen.getByRole("button", { name: "Apply exact replacement" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      kind: "confirm-watchlist-import",
      token: "pw2.import.token",
      expectedPreferenceGeneration: 2,
      previewFingerprint: "preview-v1-12-deadbeef",
    }));
    await waitFor(() => expect(screen.queryByText("Exact replacement preview")).toBeNull());
    expect((screen.getByLabelText("Import a portable token") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the preview and entered token when the replacement is not applied", async () => {
    const onConfirm = vi.fn().mockResolvedValue(null);
    renderPanel({ state: writableState, canMutate: true, onPreview: vi.fn().mockResolvedValue(importPreview()), onConfirm });

    enterImportToken("pw2.import.token");
    await screen.findByText("Exact replacement preview");
    fireEvent.click(screen.getByRole("button", { name: "Apply exact replacement" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(screen.getByText("Exact replacement preview")).toBeTruthy();
    expect((screen.getByLabelText("Import a portable token") as HTMLTextAreaElement).value).toBe("pw2.import.token");
  });

  it("invalidates the preview when the token is edited or the preview is discarded", async () => {
    const onPreview = vi.fn().mockResolvedValue(importPreview());
    renderPanel({ state: writableState, canMutate: true, onPreview });

    enterImportToken("pw2.import.token");
    await screen.findByText("Exact replacement preview");
    expect(screen.getByRole("button", { name: "Apply exact replacement" }).hasAttribute("disabled")).toBe(false);

    enterImportToken("pw2.edited.token");
    expect(screen.queryByText("Exact replacement preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply exact replacement" })).toBeNull();

    await screen.findByText("Exact replacement preview");
    fireEvent.click(screen.getByRole("button", { name: "Discard preview" }));
    expect(screen.queryByText("Exact replacement preview")).toBeNull();
    expect(onPreview).toHaveBeenCalledTimes(2);
  });

  it("renders replacement rows and coverage effects with catalog and preset labels", async () => {
    renderPanel({
      state: writableState,
      canMutate: true,
      onPreview: vi.fn().mockResolvedValue(importPreview({
        preview: {
          directAdds: ["usdc-circle", "mystery-coin"],
          directRemoves: ["old-coin"],
          directChanges: [],
          presetAdds: ["usd-top25"],
          presetRemoves: [], presetChanges: [],
          directBroadenedCoverage: [],
          directRemovedCoverage: [{ id: "old-coin", alertTypes: ["depeg"] }],
          presetBroadenedCoverage: [{ id: "usd-top25", alertTypes: ["safety"] }],
          presetRemovedCoverage: [],
        },
      })),
    });

    enterImportToken("pw2.import.token");
    await screen.findByText("Exact replacement preview");

    expect(screen.getByText("Direct rows added: 2")).toBeTruthy();
    expect(screen.getByText("Direct rows removed: 1")).toBeTruthy();
    expect(screen.getByText("Presets added: 1")).toBeTruthy();
    expect(screen.getByText("USDC (usdc-circle)")).toBeTruthy();
    expect(screen.getByText("mystery-coin")).toBeTruthy();
    expect(screen.getByText("USD Top 25")).toBeTruthy();
    expect(screen.getByText("old-coin: depeg")).toBeTruthy();
    expect(screen.getByText("USD Top 25: safety")).toBeTruthy();
  });

  it("displays the exported token and reports copy success and failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Export watchlist" }));
    const tokenBox = (await screen.findByLabelText("Portable token")) as HTMLTextAreaElement;
    expect(tokenBox.value).toBe("pw2.payload.digest");

    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await screen.findByText("Copied.");
    expect(writeText).toHaveBeenCalledWith("pw2.payload.digest");

    writeText.mockRejectedValueOnce(new Error("blocked"));
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await screen.findByText("Select and copy the token above.");
  });
});
