-- Remove de-tracked mint/burn coins (batch 2) and purge stale historical data.
-- Coins removed from MINT_BURN_CONFIGS:
-- satUSD (218), EURAU (319), VCHF (157), pUSD (266), VEUR (158),
-- GYEN (122), USDA (220), XSGD (289), FPI (66).

DELETE FROM mint_burn_events
WHERE stablecoin_id IN ('218', '319', '157', '266', '158', '122', '220', '289', '66');

DELETE FROM mint_burn_hourly
WHERE stablecoin_id IN ('218', '319', '157', '266', '158', '122', '220', '289', '66');

DELETE FROM mint_burn_sync_state
WHERE config_key IN (
  'ethereum-0x1958853a8be062dc4f401750eb233f5850f0d0d2', -- satUSD (218)
  'ethereum-0x4933a85b5b5466fbaf179f72d3de273c287ec2c2', -- EURAU (319)
  'ethereum-0x79d4f0232a66c4c91b89c76362016a1707cfbf4f', -- VCHF (157)
  'ethereum-0xdddd73f5df1f0dc31373357beac77545dc5a6f3f', -- pUSD (266)
  'ethereum-0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3', -- VEUR (158)
  'ethereum-0xc08512927d12348f6620a698105e1baac6ecd911', -- GYEN (122)
  'ethereum-0x8a60e489004ca22d775c5f2c657598278d17d9c2', -- USDA (220)
  'ethereum-0x70e8de73ce538da2beed35d14187f6959a8eca96', -- XSGD (289)
  'ethereum-0x5ca135cb8527d76e932f34b5145575f9d8cbe08e'  -- FPI (66)
);
