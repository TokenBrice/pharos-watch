import { describe, expect, it } from "vitest";
import { getTreasuryDebankProfiles } from "@/lib/treasury-debank";

describe("getTreasuryDebankProfiles", () => {
  it("returns one Debank profile per reviewed owner wallet", () => {
    expect(getTreasuryDebankProfiles("maker")).toEqual([
      {
        address: "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f",
        chainLabel: "Arbitrum",
        displayAddress: "0x10e6...55f2f",
        href: "https://debank.com/profile/0x10e6593cdda8c58a1d0f14c5164b376352a55f2f",
      },
      {
        address: "0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB",
        chainLabel: "Ethereum",
        displayAddress: "0xBE8E...E98FB",
        href: "https://debank.com/profile/0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB",
      },
    ]);
  });

  it("deduplicates repeated addresses that are tracked across multiple chains", () => {
    expect(getTreasuryDebankProfiles("flying-tulip")).toEqual([
      {
        address: "0x1118e1c057211306a40A4d7006C040dbfE1370Cb",
        chainLabel: "Avalanche / Base / BSC / Ethereum / Sonic",
        displayAddress: "0x1118...370Cb",
        href: "https://debank.com/profile/0x1118e1c057211306a40A4d7006C040dbfE1370Cb",
      },
    ]);
  });

  it("returns no profiles when a treasury has no reviewed EVM owner wallets", () => {
    expect(getTreasuryDebankProfiles("jupiter")).toEqual([]);
  });
});
