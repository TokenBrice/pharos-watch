// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
} from "@shared/lib/telegram-mini-app-contract";
import type { TelegramMiniAppPortabilityResponse } from "../app/types";
import { makeMiniAppState } from "../app/mini-app-test-fixtures";
import { WatchlistPortabilityPanel } from "../app/components/WatchlistPortabilityPanel";

const preview: TelegramMiniAppPortabilityResponse = {
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
  },
};

afterEach(cleanup);

describe("WatchlistPortabilityPanel edit lockout", () => {
  it("disables Apply exact replacement during a 429 edit lockout", async () => {
    const onConfirm = vi.fn();
    render(
      <WatchlistPortabilityPanel
        state={makeMiniAppState()}
        canMutate
        canReadPortability
        isMutating={false}
        isWriteLocked
        pendingOperation={null}
        onExport={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(preview)}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText("Import a portable token"), {
      target: { value: "pw2.import.token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
    const apply = await screen.findByRole("button", { name: "Apply exact replacement" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.click(apply);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
