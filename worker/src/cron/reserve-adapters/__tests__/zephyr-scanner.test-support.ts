// Existing historical scanner fixture retained from zephyr-scanner.test.ts.
export const ZEPHYR_ENDPOINT = "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc";
export const ZEPHYR_CAPTURE = {
  total: 580,
  limit: 1,
  order: "desc",
  results: [{
    captured_at: "2024-03-09T16:00:00.000Z",
    reserve_height: 773828,
    previous_height: 773827,
    hf_version: 11,
    on_chain: {
      zeph_reserve_atoms: "3838581055538091486",
      zeph_reserve: 3_838_581.055538091,
      zsd_circ_atoms: "385036812914440613",
      zsd_circ: 385_036.8129144406,
      reserve_ratio: 3.173356,
      reserve_ratio_ma: 3.218013,
      zsd_yield_reserve_atoms: "315747159842202047",
      zsd_yield_reserve: 315_747.159842202,
    },
    pricing_record: {
      spot: 318310060000,
      timestamp: 1710000000,
      reserve_ratio: 3173355150000,
      reserve_ratio_ma: 3218168250000,
    },
    raw: {
      assets: "1221858966103193233",
      liabilities: "385036812914440613",
      zeph_reserve: "3838581055538091486",
      num_stables: "385036812914440613",
      zyield_reserve: "315747159842202047",
      reserve_ratio: "3.173356",
      reserve_ratio_ma: "3.218013",
    },
  }],
};
