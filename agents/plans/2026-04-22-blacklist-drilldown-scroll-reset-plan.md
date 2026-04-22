## Blacklist drilldown scroll reset fix

### Assumption

- The drilldown table jump-to-top is caused by client rerenders, not by browser-native overflow or CSS anchoring.

### Success criteria

- The `/blacklist` drilldown table remains at the user-selected vertical scroll position while scrolling.
- The generic `StablecoinTable` still resets scroll when its actual sort/filter/pinning inputs change.
- A regression test covers the no-pinning rerender path that affected the blacklist drilldown.

### Plan

1. Stabilize the no-pinning `pinnedStablecoinIds` input in `StablecoinTable`.
2. Add a targeted table test that rerenders with unchanged props and verifies no scroll reset occurs.
3. Run the focused table tests plus lint/typecheck/build validation.
