// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeMiniAppState } from "@shared/test-utils/telegram-mini-app-state";
import { AddCoinsScreen } from "./AddCoinsScreen";
import { CoinScreen } from "./CoinScreen";

const NAV_COIN = {
  stablecoinId: "susde-ethena",
  symbol: "sUSDe",
  name: "Ethena Staked USDe",
  peg: "USD",
  pegLabel: "USDe NAV",
  rank: 27,
  variant: true,
};

const state = makeMiniAppState({
  catalog: { recommendedPresets: [], searchableCoins: [NAV_COIN] },
  subscriptions: [],
});

afterEach(cleanup);

describe("Mini App NAV peg labels", () => {
  it("renders the catalog peg label on a coin screen instead of the raw peg code", () => {
    render(
      <CoinScreen
        state={state}
        nowSec={0}
        canEdit
        busy={false}
        pendingOperation={null}
        onMutate={() => {}}
        coinId={NAV_COIN.stablecoinId}
        webApp={null}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/USDe NAV/)).toBeTruthy();
    expect(screen.queryByText(/USD peg/)).toBeNull();
  });

  it("renders the catalog peg label in Add coins search rows", () => {
    render(
      <AddCoinsScreen
        state={state}
        nowSec={0}
        canEdit
        busy={false}
        pendingOperation={null}
        onMutate={() => {}}
        onApply={async () => true}
        onDone={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search stablecoins"), { target: { value: "susde" } });
    expect(screen.getByText(/USDe NAV/)).toBeTruthy();
    expect(screen.queryByText(/USD peg/)).toBeNull();
  });
});
