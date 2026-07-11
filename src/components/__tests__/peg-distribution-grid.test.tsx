// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import type { PegCurrency } from "@shared/types";

const TEST_PEGS: PegCurrency[] = ["USD", "EUR", "GBP", "CHF", "BRL", "XOF", "GOLD", "SILVER", "VAR"];

const TEST_COUNTS: Record<PegCurrency, number> = {
  USD: 154,
  EUR: 13,
  GBP: 2,
  CHF: 3,
  BRL: 1,
  JPY: 0,
  INR: 0,
  KRW: 0,
  HKD: 0,
  MYR: 0,
  SGD: 0,
  TRY: 0,
  AUD: 0,
  ZAR: 0,
  CAD: 0,
  PHP: 0,
  RUB: 0,
  CNY: 0,
  CNH: 0,
  MXN: 0,
  VND: 0,
  UAH: 0,
  ARS: 0,
  XOF: 1,
  IDR: 0,
  KGS: 0,
  NGN: 0,
  GOLD: 8,
  SILVER: 1,
  VAR: 3,
  OTHER: 0,
};

function pegCoinCount(peg: PegCurrency): number {
  return TEST_COUNTS[peg];
}

afterEach(() => {
  cleanup();
});

describe("PegBrowseStrip", () => {
  it("uses the Figma collapsed fiat preview", () => {
    render(<PegBrowseStrip pegs={TEST_PEGS} pegCoinCount={pegCoinCount} />);

    expect(screen.getByRole("link", { name: "US Dollar (154)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Euro (13)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "British Pound (2)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Brazilian Real (1)" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Swiss Franc (3)" })).toBeNull();
  });

  it("restores individual fiat pegs when expanded", () => {
    render(<PegBrowseStrip pegs={TEST_PEGS} pegCoinCount={pegCoinCount} />);

    fireEvent.click(screen.getByRole("button", { name: /View More/ }));

    expect(screen.getByRole("link", { name: "British Pound (2)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Brazilian Real (1)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Swiss Franc (3)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "West African CFA Franc (1)" }).getAttribute("href")).toBe(
      "/stablecoins/xof",
    );
    expect(screen.getByRole("button", { name: /View Less/ })).toBeTruthy();
  });
});
