-- 0024: Add locked liquidity percentage from CoinGecko onchain data
ALTER TABLE dex_liquidity ADD COLUMN locked_liquidity_pct REAL;
