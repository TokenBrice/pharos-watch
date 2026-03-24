# Bluechip Hero Reimplementation Plan

## Goal

Restore explicit Bluechip grades in the stablecoin hero so users can distinguish the external Bluechip rating from Pharos-owned scores.

## Plan

1. Inspect the stablecoin hero and Bluechip badge data path.
2. Reposition the Bluechip display inside the hero metadata area.
3. Change the badge copy to explicit `Bluechip: <grade>` labeling.
4. Add focused tests for the hero and the badge.
5. Run targeted validation, then the full merge gate before pushing.
