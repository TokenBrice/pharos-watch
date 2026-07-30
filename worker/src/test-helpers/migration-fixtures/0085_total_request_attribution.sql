-- rollout-safety: backward-compatible

ALTER TABLE api_keys
  ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'external'
  CHECK (traffic_class IN ('external', 'site'));

CREATE TABLE IF NOT EXISTS api_request_consumer_stats (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('public-api', 'site-api')),
  consumer_class TEXT NOT NULL CHECK (consumer_class IN ('site', 'external')),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, route_key, lane, consumer_class)
);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_bucket
  ON api_request_consumer_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_route
  ON api_request_consumer_stats(route_key, bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_lane
  ON api_request_consumer_stats(lane, bucket_start);

INSERT OR REPLACE INTO api_request_consumer_stats (
  bucket_start,
  route_key,
  route_path,
  lane,
  consumer_class,
  request_count
)
SELECT
  bucket_start,
  route_key,
  route_path,
  'public-api',
  CASE source
    WHEN 'web' THEN 'site'
    ELSE 'external'
  END,
  request_count
FROM api_request_source_stats;

CREATE TABLE IF NOT EXISTS site_data_request_stats (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  delivery_path TEXT NOT NULL CHECK (delivery_path IN (
    'pages-cache-hit',
    'pages-upstream-fetch',
    'pages-upstream-timeout',
    'pages-upstream-error'
  )),
  upstream_lane TEXT NOT NULL DEFAULT ''
    CHECK (upstream_lane IN ('', 'site-api', 'public-api-fallback')),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, route_key, delivery_path, upstream_lane)
);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_bucket
  ON site_data_request_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_route
  ON site_data_request_stats(route_key, bucket_start);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_delivery
  ON site_data_request_stats(delivery_path, bucket_start);
