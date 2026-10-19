-- rollout-safety: backward-compatible
-- Reader-first rollout: existing writers keep their named-column inserts unchanged.
CREATE TABLE api_request_source_samples (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('public-api', 'site-api')),
  consumer_class TEXT NOT NULL CHECK (consumer_class IN ('site', 'external')),
  authentication_class TEXT NOT NULL CHECK (authentication_class IN ('keyed', 'unkeyed', 'not-applicable')),
  sample_inverse_rate INTEGER NOT NULL CHECK (sample_inverse_rate > 0),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  PRIMARY KEY (bucket_start, route_key, lane, consumer_class, authentication_class, sample_inverse_rate)
);

CREATE TABLE site_data_request_samples (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  delivery_path TEXT NOT NULL CHECK (delivery_path IN (
    'pages-cache-hit', 'pages-upstream-fetch', 'pages-upstream-timeout', 'pages-upstream-error'
  )),
  upstream_lane TEXT NOT NULL DEFAULT '' CHECK (upstream_lane IN ('', 'site-api', 'public-api-fallback')),
  sample_inverse_rate INTEGER NOT NULL CHECK (sample_inverse_rate > 0),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  PRIMARY KEY (bucket_start, route_key, delivery_path, upstream_lane, sample_inverse_rate)
);

ALTER TABLE api_key_request_stats ADD COLUMN source_v2_request_count INTEGER NOT NULL DEFAULT 0;
