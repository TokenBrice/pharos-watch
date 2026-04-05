# API Request Source Attribution Plan

Date: 2026-04-01

## Goal

Add a durable way to measure how much public Pharos API traffic comes from the Pharos website versus external consumers.

## Constraints

- Keep the implementation backward-compatible.
- Avoid adding a custom request header that would trigger CORS preflights on every browser GET.
- Keep route cardinality bounded for storage and reporting.
- Exclude admin-only and webhook traffic from the public-load metric.

## Plan

1. Add a public-API request-source classifier in the Worker entry path.
   - Treat requests from `https://pharos.watch` as first-party when browser metadata supports that conclusion.
   - Use a browser-safe frontend marker in `Accept` instead of an `X-*` header.
   - Bucket everything else as external for this metric.

2. Persist aggregated counts in D1.
   - Add a new minute-bucketed request-source stats table.
   - Record `bucket_start`, normalized route key/path, source bucket, and count.
   - Prune old buckets opportunistically with bounded retention.

3. Expose an admin-only read endpoint.
   - Return totals, percentage split, route breakdown, and time buckets for a requested window.
   - Default to a practical window for operator use.

4. Update the frontend fetch helper.
   - Stamp first-party browser API requests with the safe `Accept` marker.

5. Document the new telemetry path and query surface.

6. Validate with targeted tests plus the repo’s standard lint/test/build/typecheck gates.
