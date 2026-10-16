import { describe, expect, it } from "vitest";
import {
  renderEnvExample,
} from "../env-contract";

describe("env contract manifest", () => {

  it("renders .env.example from the manifest without emitting the external DB binding", () => {
    const envExample = renderEnvExample();

    expect(envExample).not.toContain("\nDB=");
    expect(envExample.match(/^SITE_API_SHARED_SECRET=/gm)).toHaveLength(1);
    expect(envExample).toContain("NEXT_PUBLIC_API_BASE=");
    expect(envExample).not.toContain("VAULTS_FYI_");
    expect(envExample).toContain("SITE_API_ORIGIN=https://site-api.pharos.watch");
    expect(envExample).toContain("SELECTOR_SNAPSHOT_IP_HASH_SECRET=");
    expect(envExample).toContain("TELEGRAM_ADOPTION_IP_HASH_SECRET=");
  });

});
