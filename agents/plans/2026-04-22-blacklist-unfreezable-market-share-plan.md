## Blacklist page: unfreezable market share stat

### Assumption

- "Unfreezable stablecoin market share" maps to the existing blacklist-status bucket `no`.
- Numerator = current circulating USD market cap of tracked active stablecoins in bucket `no`.
- Denominator = current circulating USD market cap of all tracked active stablecoins included in the blacklist-status distribution.

### Success criteria

- `/blacklist` shows a new stat card with the unfreezable market share as a percentage.
- The card uses the same blacklist-status resolution already shown elsewhere on the page.
- The change does not widen the blacklist-summary API when the existing stablecoin + report-card queries already provide the needed data.
- A focused test covers the derived percentage rendering.

### Plan

1. Reuse the existing blacklist-status bucket calculation on the client.
2. Add a fourth summary card on the second stats row for the derived percentage.
3. Add a small doc note for the new page stat and run targeted validation.
