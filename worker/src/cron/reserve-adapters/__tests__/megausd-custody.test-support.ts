import type { BackingAndSupplyPayload } from "../custody-inventory";

export const MEGAUSD_URL = "https://app.megausd.money/api/transparency/backing-and-supply/current";

export const MEGAUSD_BACKING: BackingAndSupplyPayload = {
  backingAssets: {
    USDC: [
      { amount: 1618402.389424, custodian: "0xE0406beE6D58bCd7C1cA78191b6fde9CA060F6f2" },
      { amount: 15319532.925638, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" },
      { amount: 440, custodian: "0x01b3AfeBdA3ED0E55feDb10DAdA5eF8Dbe8f8d0C" },
      { amount: 1000.109, custodian: "0x99F97f2822478f71e6ea8BD872e61DF10aE19ccd" },
      { amount: 0, custodian: "0xF6a4347Fe4F2c8D7228d3d53ab8e0d0cFC507DDC" },
    ],
    USDm: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
    USDtb: [
      { amount: 1607.822777, custodian: "0xE0406beE6D58bCd7C1cA78191b6fde9CA060F6f2" },
      { amount: 19187.0188631, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" },
      { amount: 121, custodian: "0x01b3AfeBdA3ED0E55feDb10DAdA5eF8Dbe8f8d0C" },
    ],
  },
  lastUpdatedAt: "2026-09-09T15:55:59.000Z",
  supply: 31379.8289956866,
};
