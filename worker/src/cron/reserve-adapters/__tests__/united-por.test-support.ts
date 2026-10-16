import type { UnitedPorPayload } from "../united-por";

export const UNITED_POR_ENDPOINT = "https://u.tech/u-client-api/v1/public/u/por";

// Captured 2026-07-09 from GET https://u.tech/u-client-api/v1/public/u/por
export const UNITED_POR_PAYLOAD: UnitedPorPayload = {
  accountName: "United Stables",
  totalReserve: "1038136298.86",
  totalToken: "1030959209.00",
  updatedAt: "2026-07-09T16:10:01.559Z",
  ripcord: false,
  ripcordDetails: [],
};
