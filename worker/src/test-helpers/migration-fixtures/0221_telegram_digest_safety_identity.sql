-- rollout-safety: backward-compatible
-- Bind each immutable digest edition to the exact Safety Score publication
-- used while authoring it. Legacy pending editions remain explicitly unbound
-- and are rejected by the new Worker before any Telegram effect.

ALTER TABLE telegram_digest_outbox
  ADD COLUMN safety_context_json TEXT NOT NULL
  DEFAULT '{"status":"unavailable","expectedModel":"v8","identity":null,"publishedAt":null,"reason":"legacy-unbound"}'
  CHECK (
    json_valid(safety_context_json)
    AND json_type(safety_context_json) = 'object'
  );
