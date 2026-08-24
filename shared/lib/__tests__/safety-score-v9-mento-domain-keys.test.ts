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
  it("canonicalizes one immediate Mento Safe to one failure-domain key", () => {
    const sidecars: readonly MintAuthoritySidecar[] = [ceur, chfm, cusd, gbpm, jpym];
    const keys = new Set(
      sidecars.flatMap((sidecar) =>
        sidecar.mintAuthority.controls
          .filter((control) => control.address?.toLowerCase() === MENTO_SAFE_ADDRESS)
          .flatMap((control) =>
            control.failureDomainKeys?.length
              ? control.failureDomainKeys
              : [`${control.chain ?? "chain-unresolved"}:${control.address!.toLowerCase()}`],
          ),
      ),
    );

    expect([...keys]).toEqual([MENTO_SAFE_DOMAIN]);
  });
});
