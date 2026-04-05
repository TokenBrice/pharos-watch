# Dependency Map Mobile Visibility Fix Plan

**Date**: 2026-03-28
**Scope**: `/dependency-map/` frontend route only

## Root Cause

`src/app/dependency-map/client.tsx` wrapped `ContagionGraph` in `hidden md:block`, which suppressed the graph entirely below the `md` breakpoint and left only the mobile summary card visible.

## Plan

1. Remove the breakpoint gate so the graph renders on every screen size.
2. Keep the existing mobile summary as a supplemental mobile card, not a replacement view.
3. Update `docs/dependency-map.md` so the documented mobile behavior matches the implementation.
4. Add a regression test around the client component to prevent reintroducing a mobile-hidden graph wrapper.
5. Validate with targeted tests, lint, and a frontend build.
