-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Commit 82ea00204 (2026-07-19) removed these four coins from the tracked
-- registry without cleaning their Telegram follow rows. The rows can no longer
-- alert, be removed by ticker, or be exported. Delete only these exact ids;
-- per-coin snooze state lives on the same rows. Bump preference_generation
-- first, as every runtime subscription removal does.
UPDATE telegram_subscribers
SET preference_generation = preference_generation + 1
WHERE chat_id IN (
  SELECT chat_id FROM telegram_subscriptions
  WHERE stablecoin_id IN ('krwo-gimswap', 'mnee-mnee', 'pusd-pleasing', 'veur-vnx')
);

DELETE FROM telegram_subscriptions
WHERE stablecoin_id IN ('krwo-gimswap', 'mnee-mnee', 'pusd-pleasing', 'veur-vnx');
