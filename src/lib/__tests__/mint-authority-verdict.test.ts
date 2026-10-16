import { describe, expect, it } from "vitest";
import {
  buildMintAuthorityVerdict,
  describeMintGateControls,
  formatMintTimelockDelay,
  type MintAuthorityVerdictControl,
  type MintAuthorityVerdictInput,
} from "../mint-authority-verdict";

function control(overrides: Partial<MintAuthorityVerdictControl>): MintAuthorityVerdictControl {
  return { authorityType: "contract", directMintAbility: "direct", ...overrides };
}

const BASE: MintAuthorityVerdictInput = {
  symbol: "XUSD",
  bandLabel: "Managed",
  mintPath: "issuer-direct-mint",
  authorityPosture: "unbounded-reconciled",
  controls: [],
  controlsTruncated: false,
  parentSymbol: null,
};

describe("formatMintTimelockDelay", () => {
  it.each<{ seconds: number | null; expected: string | null }>([
    { seconds: 86400, expected: "1d" },
    { seconds: 172800, expected: "2d" },
    { seconds: 3600 * 49, expected: "49h" },
    { seconds: 1800, expected: "30m" },
    { seconds: 0, expected: null },
    { seconds: null, expected: null },
  ])("formats $seconds seconds as $expected", ({ seconds, expected }) => {
    expect(formatMintTimelockDelay(seconds)).toBe(expected);
  });
});

describe("describeMintGateControls", () => {
  it("names the two strongest mint-gate groups and skips upgrade or parameter-only powers", () => {
    expect(describeMintGateControls([
      control({ authorityType: "contract", directMintAbility: "cap-limited" }),
      control({ authorityType: "issuer-backend", directMintAbility: "cap-limited" }),
      control({ authorityType: "safe", directMintAbility: "can-authorize", threshold: 5, signerCount: 10 }),
      control({ authorityType: "timelock", directMintAbility: "can-authorize", timelockDelaySec: 86400 }),
      control({ authorityType: "eoa", directMintAbility: "upgrade-only" }),
    ], false)).toBe("a 5/10 Safe and a 1d timelock");
  });

  it("counts groups, keeps a shared threshold, and picks the right article", () => {
    expect(describeMintGateControls([
      control({ authorityType: "multisig", threshold: 3, signerCount: 6 }),
      control({ authorityType: "multisig", threshold: 2, signerCount: 3 }),
    ], false)).toBe("two multisigs");
    expect(describeMintGateControls([
      control({ authorityType: "multisig", threshold: 3, signerCount: 6 }),
      control({ authorityType: "multisig", threshold: 3, signerCount: 6 }),
    ], false)).toBe("two 3/6 multisigs");
    expect(describeMintGateControls([
      control({ authorityType: "multisig", threshold: 8, signerCount: 12 }),
      control({ authorityType: "eoa", directMintAbility: "can-authorize" }),
    ], false)).toBe("an 8/12 multisig and an EOA");
  });

  it("does not name a count the bounded census cannot prove", () => {
    expect(describeMintGateControls([control({}), control({})], true)).toBe("multiple contracts");
  });

  it("returns null when no control gates minting", () => {
    expect(describeMintGateControls([control({ directMintAbility: "parameter-only" })], false)).toBeNull();
  });
});

describe("buildMintAuthorityVerdict", () => {

  it("states inheritance for wrappers and omits the control clause where it does not describe minting", () => {
    expect(buildMintAuthorityVerdict({
      ...BASE,
      symbol: "sXUSD",
      bandLabel: "Hardened",
      mintPath: "wrapped-or-variant-inherited",
      authorityPosture: "none-resolved-mint",
      controls: [control({})],
      parentSymbol: "XUSD",
    })).toBe("Hardened — sXUSD wraps XUSD and inherits its mint risk; no local privileged mint path was found.");
    expect(buildMintAuthorityVerdict({
      ...BASE,
      bandLabel: null,
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      controls: [control({})],
    })).toBe("Not rated — users mint XUSD against collateral in immutable contracts; no privileged mint authority was found.");
  });

});
