import { describe, expect, it } from "vitest";
import ceur from "../../data/stablecoins/domains/mint-authority/ceur-celo.json";
import chfm from "../../data/stablecoins/domains/mint-authority/chfm-mento.json";
import cusd from "../../data/stablecoins/domains/mint-authority/cusd-celo.json";
import gbpm from "../../data/stablecoins/domains/mint-authority/gbpm-mento.json";
import jpym from "../../data/stablecoins/domains/mint-authority/jpym-mento.json";

const MENTO_SAFE_ADDRESS = "0x58099b74f4acd642da77b4b7966b4138ec5ba458";
const MENTO_SAFE_DOMAIN = `safe:celo:${MENTO_SAFE_ADDRESS}`;

interface MintAuthoritySidecar {
  mintAuthority: {
    controls: readonly {
      chain?: string;
      address?: string;
      failureDomainKeys?: readonly string[];
    }[];
  };
}

describe("Safety Score v9 Mento control identity", () => {
  it.each(Object.entries({ ceur, chfm, cusd, gbpm, jpym }))("%s retains the canonical immediate Safe identity", (_name, sidecar: MintAuthoritySidecar) => {
    const controls = sidecar.mintAuthority.controls.filter(
      (control) => control.address?.toLowerCase() === MENTO_SAFE_ADDRESS,
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.failureDomainKeys).toEqual([MENTO_SAFE_DOMAIN]);
    }
  });
});
