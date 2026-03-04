-- Remove de-tracked mint/burn coins and purge stale historical data.
-- Coins removed from MINT_BURN_CONFIGS:
-- USBD (253), A7A5 (258), rwaUSDi (340), AEUR (147), USDQ (275),
-- USDX (263), MIM (10), ZeUSD (225), USAT (343), USDU (304),
-- ZARP (cg-zarp), CADC (145), PHT (299), EURQ (cg-eurq), USCC (cg-uscc).

DELETE FROM mint_burn_events
WHERE stablecoin_id IN (
  '253', '258', '340', '147', '275', '263', '10', '225', '343', '304',
  'cg-zarp', '145', '299', 'cg-eurq', 'cg-uscc'
);

DELETE FROM mint_burn_hourly
WHERE stablecoin_id IN (
  '253', '258', '340', '147', '275', '263', '10', '225', '343', '304',
  'cg-zarp', '145', '299', 'cg-eurq', 'cg-uscc'
);

DELETE FROM mint_burn_sync_state
WHERE config_key IN (
  'ethereum-0x6bede1c6009a78c222d9bdb7974bb67847fdb68c', -- USBD (253)
  'ethereum-0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9', -- A7A5 (258)
  'ethereum-0xa39986f96b80d04e8d7aeaaf47175f47c23fd0f4', -- rwaUSDi (340)
  'ethereum-0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21', -- AEUR (147)
  'ethereum-0xc83e27f270cce0a3a3a29521173a83f402c1768b', -- USDQ (275)
  'ethereum-0xf8750b54d86be7ae9e32b4a0c826811198d63313', -- USDX (263)
  'ethereum-0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3', -- MIM (10)
  'ethereum-0x7dc9748da8e762e569f9269f48f69a1a9f8ea761', -- ZeUSD (225)
  'ethereum-0x07041776f5007aca2a54844f50503a18a72a8b68', -- USAT (343)
  'ethereum-0xdde3ec717f220fc6a29d6a4be73f91da5b718e55', -- USDU (304)
  'ethereum-0xb755506531786c8ac63b756bab1ac387bacb0c04', -- ZARP (cg-zarp)
  'ethereum-0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef', -- CADC (145)
  'ethereum-0xbe370ad45d44eb45174c4ec60b88839fef32c077', -- PHT (299)
  'ethereum-0x8df723295214ea6f21026eeeb4382d475f146f9f', -- EURQ (cg-eurq)
  'ethereum-0x14d60e7fdc0d71d8611742720e4c50e7a974020c'  -- USCC (cg-uscc)
);
