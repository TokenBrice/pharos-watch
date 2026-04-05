# Treasury Issuer Coverage Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand stablecoin issuer treasury coverage from 4 to 18 by adding 13 issuers with DefiLlama treasury adapters and reclassifying Aave as a stablecoin issuer (GHO).

**Architecture:** Data-only expansion. Add manifest entries to the build script, add two require mocks for non-standard adapter dependencies, regenerate the seed registry JSON. No cron/API/frontend changes — the pipeline consumes seeds generically.

**Tech Stack:** TypeScript (build script), DefiLlama GitHub adapters, Node.js `vm` sandbox

**Spec:** `docs/superpowers/specs/2026-04-05-treasury-issuer-expansion-design.md`

---

### Task 1: Add require mocks to build script

Two adapters (`usual.js`, `flying-tulip.js`) use non-standard requires that the build script's VM sandbox doesn't handle. Add mocks so the static config extraction succeeds.

**Files:**
- Modify: `scripts/build-treasury-seeds.ts:214-234` (the `require` handler in `extractAdapterConfig`)

- [ ] **Step 1: Add mock for `@defillama/sdk`**

In `scripts/build-treasury-seeds.ts`, inside the `require` handler of `extractAdapterConfig`, add a mock before the final `throw`. The `sdk.util.sumChainTvls` is called at module evaluation time in `flying-tulip.js` (it wraps TVL functions), so the mock must return a callable.

```typescript
      if (request === "@defillama/sdk") {
        return {
          util: {
            sumChainTvls: (..._fns: unknown[]) => async () => ({}),
          },
        };
      }
```

Add this block after the existing `request.endsWith("/helper/utils")` check and before the `throw`.

- [ ] **Step 2: Add mock for fira treasury helper**

`usual.js` requires `../fira/treasuryHelper`. The `addFiraTreasuryPositions` function is only called inside async TVL functions (not at config export time), but the require itself runs at module load and must not throw.

```typescript
      if (request.includes("/fira/")) {
        return {
          addFiraTreasuryPositions: async () => ({}),
        };
      }
```

Add this block immediately after the `@defillama/sdk` mock.

- [ ] **Step 3: Verify the final require handler reads correctly**

The full `require` function inside `extractAdapterConfig` should now be:

```typescript
    require: (request: string) => {
      if (request.endsWith("/helper/treasury")) {
        return {
          nullAddress: "0x0000000000000000000000000000000000000000",
          treasuryExports: (config: unknown) => config,
        };
      }
      if (request.endsWith("/helper/coreAssets.json")) {
        return createAddressProxy();
      }
      if (request.endsWith("/helper/karpatkey")) {
        return {
          karpatKeyTvl: async () => ({}),
        };
      }
      if (request.endsWith("/helper/utils")) {
        return {
          mergeExports,
        };
      }
      if (request === "@defillama/sdk") {
        return {
          util: {
            sumChainTvls: (..._fns: unknown[]) => async () => ({}),
          },
        };
      }
      if (request.includes("/fira/")) {
        return {
          addFiraTreasuryPositions: async () => ({}),
        };
      }
      throw new Error(`Unsupported adapter dependency in ${adapterFile}: ${request}`);
    },
```

---

### Task 2: Add manifest entries and flip Aave

**Files:**
- Modify: `scripts/build-treasury-seeds.ts:18-146` (the `MANIFEST` array)

- [ ] **Step 1: Flip Aave to launch-eligible**

In the existing Aave entry (currently at the end of the `MANIFEST` array), change `launchEligible: false` to `launchEligible: true`, add `launchPriority: 135`, and update the category from `"Protocol treasury"` to `"Stablecoin issuer"` (Aave issues GHO — it belongs in the issuer cohort for this feature). Remove the held-back note.

```typescript
  {
    protocolId: "aave",
    slug: "aave",
    name: "Aave",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 135,
    adapterFile: "aave.js",
  },
```

- [ ] **Step 2: Add 13 new manifest entries**

Append these entries after the Aave entry, inside the `MANIFEST` array:

```typescript
  {
    protocolId: "usual",
    slug: "usual",
    name: "Usual",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 140,
    adapterFile: "usual.js",
  },
  {
    protocolId: "synthetix",
    slug: "synthetix",
    name: "Synthetix",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 150,
    adapterFile: "synthetix.js",
  },
  {
    protocolId: "abracadabra",
    slug: "abracadabra",
    name: "Abracadabra",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 160,
    adapterFile: "abracadabra.js",
  },
  {
    protocolId: "alchemix",
    slug: "alchemix",
    name: "Alchemix",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 170,
    adapterFile: "alchemix.js",
  },
  {
    protocolId: "inverse-finance",
    slug: "inverse-finance",
    name: "Inverse Finance",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 180,
    adapterFile: "inverse.js",
  },
  {
    protocolId: "resupply",
    slug: "resupply",
    name: "Resupply",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 190,
    adapterFile: "resupply.js",
  },
  {
    protocolId: "gyroscope",
    slug: "gyroscope",
    name: "Gyroscope",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 200,
    adapterFile: "gyro.js",
  },
  {
    protocolId: "flying-tulip",
    slug: "flying-tulip",
    name: "Flying Tulip",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 210,
    adapterFile: "flying-tulip.js",
  },
  {
    protocolId: "jupiter",
    slug: "jupiter",
    name: "Jupiter",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 220,
    adapterFile: "jupiter.js",
    notes: ["Solana-native protocol. Adapter may contain only non-EVM addresses, resulting in zero EVM owners."],
  },
  {
    protocolId: "maple",
    slug: "maple",
    name: "Maple",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 230,
    adapterFile: "maple.js",
  },
  {
    protocolId: "metronome",
    slug: "metronome",
    name: "Metronome",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 240,
    adapterFile: "metronome.js",
  },
  {
    protocolId: "unitas",
    slug: "unitas",
    name: "Unitas",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 250,
    adapterFile: "unitas.js",
  },
  {
    protocolId: "alto",
    slug: "alto",
    name: "Alto",
    category: "Stablecoin issuer",
    launchEligible: true,
    launchPriority: 260,
    adapterFile: "alto.js",
  },
```

---

### Task 3: Regenerate seed registry and validate output

**Files:**
- Regenerated: `shared/data/treasury-seeds.json`

- [ ] **Step 1: Run the build script**

```bash
npx tsx scripts/build-treasury-seeds.ts
```

Expected output (approximate):
```
[treasury-seeds] Wrote 27 seeds to .../shared/data/treasury-seeds.json (NN owner-chain tuples; MM launch tuples)
```

If any adapter throws an `Unsupported adapter dependency` error, the script will fail. Fix the missing mock in Task 1 before retrying.

- [ ] **Step 2: Validate seed count and structure**

```bash
python3 -c "
import json
with open('shared/data/treasury-seeds.json') as f:
    seeds = json.load(f)
print(f'Total seeds: {len(seeds)}')
launch = [s for s in seeds if s['launchEligible']]
print(f'Launch-eligible: {len(launch)}')
issuers = [s for s in seeds if s.get('category') == 'Stablecoin issuer']
print(f'Stablecoin issuers: {len(issuers)}')
total_tuples = sum(len(s['owners']) for s in seeds)
launch_tuples = sum(len(s['owners']) for s in launch)
print(f'Total owner-chain tuples: {total_tuples}')
print(f'Launch owner-chain tuples: {launch_tuples}')
zero_owners = [s['slug'] for s in seeds if len(s['owners']) == 0]
if zero_owners:
    print(f'Seeds with 0 EVM owners (expected for Solana-only): {zero_owners}')
for s in seeds:
    assert s['source'] == 'defillama-github', f'{s[\"slug\"]} has wrong source'
    assert s['extractionMode'] == 'static-seeded', f'{s[\"slug\"]} has wrong extraction mode'
print('All assertions passed')
"
```

Expected:
- Total seeds: 27
- Launch-eligible: 27 (all — Aave is now eligible)
- Stablecoin issuers: 18 (4 original + Aave reclassified + 13 new)
- Jupiter may have 0 owners (Solana-only) — that's expected

- [ ] **Step 3: Spot-check a few new seeds**

```bash
python3 -c "
import json
with open('shared/data/treasury-seeds.json') as f:
    seeds = json.load(f)
for slug in ['usual', 'synthetix', 'aave', 'gyroscope', 'flying-tulip']:
    seed = next((s for s in seeds if s['slug'] == slug), None)
    if seed:
        chains = seed['chains']
        owners = len(seed['owners'])
        print(f'{slug}: {owners} owners on {chains}')
    else:
        print(f'{slug}: NOT FOUND')
"
```

Verify each seed has at least 1 EVM owner and plausible chain coverage.

---

### Task 4: Run merge gate

- [ ] **Step 1: Run the local merge gate**

```bash
npm run test:merge-gate
```

Expected: all checks pass (lint, typecheck, tests). The only changed files are `scripts/build-treasury-seeds.ts` and `shared/data/treasury-seeds.json`, which are deploy-impacting for the worker.

If lint fails on the new code in the build script (e.g., unused `_fns` parameter), fix the lint issue and re-run.

---

### Task 5: Update design spec and commit

- [ ] **Step 1: Update design spec to remove cap.js**

In `docs/superpowers/specs/2026-04-05-treasury-issuer-expansion-design.md`:
- Remove the `cap` row from the adapter mapping table
- Change "14 issuers" → "13 issuers" in the Goal section (Aave already in registry, just reclassified)
- Change "14 to 29" → "14 to 27" seed counts
- Keep "4 to 18" issuer count (4 original + Aave reclassified + 13 new)
- Note Aave's category change from "Protocol treasury" to "Stablecoin issuer" in the adapter table
- Add a note under Risks: "`cap.js` was dropped because it uses `sumTokensExport` instead of `treasuryExports` and does not expose owner addresses in a format the build script can extract."

- [ ] **Step 2: Commit all changes**

```bash
git add scripts/build-treasury-seeds.ts shared/data/treasury-seeds.json docs/superpowers/specs/2026-04-05-treasury-issuer-expansion-design.md
git commit -m "feat(treasury): expand stablecoin issuer coverage to 18 treasuries

Add 13 new stablecoin issuer treasury seeds (Usual, Synthetix,
Abracadabra, Alchemix, Inverse Finance, Resupply, Gyroscope,
Flying Tulip, Jupiter, Maple, Metronome, Unitas, Alto) and
reclassify Aave as a stablecoin issuer (GHO), promoting it
to launch-eligible.

Adds build-script require mocks for @defillama/sdk and fira
treasury helper to support non-standard adapter dependencies.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Notes

- **cap.js dropped**: Uses `sumTokensExport` (not `treasuryExports`), no `owners` field. Would require manual owner specification or a build-script extension to extract addresses from `tokensAndOwners`. Can be added later with a `manualOwners` manifest field.
- **Jupiter may produce 0 EVM owners**: Solana-native protocol. The seed will exist in the registry but the cron will skip it naturally (no owner groups to process). If Jupiter adds EVM treasury addresses to their adapter later, they'll be picked up on the next build-script run.
- **No cron/API/frontend changes**: The pipeline iterates `TREASURY_LAUNCH_SEEDS` generically. New seeds flow through automatically.
