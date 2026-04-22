import { describe, expect, it } from "vitest";
import {
  getRuntimeEnvKeys,
  renderEnvExample,
  renderOperatorOriginAccessEnvBlock,
  renderWorkerInfrastructureEnvBlock,
} from "../env-contract";

describe("env contract manifest", () => {
  it("keeps the Pages ops required binding order stable", () => {
    expect(getRuntimeEnvKeys("pagesOps", "required")).toEqual([
      "OPS_API_SERVICE_TOKEN_ID",
      "OPS_API_SERVICE_TOKEN_SECRET",
      "CF_ACCESS_TEAM_DOMAIN",
      "CF_ACCESS_OPS_UI_AUD",
    ]);
  });

  it("renders .env.example from the manifest without emitting the external DB binding", () => {
    const envExample = renderEnvExample();

    expect(envExample).not.toContain("\nDB=");
    expect(envExample.match(/^SITE_API_SHARED_SECRET=/gm)).toHaveLength(1);
    expect(envExample).toContain("NEXT_PUBLIC_API_BASE=");
    expect(envExample).toContain("SITE_API_ORIGIN=https://site-api.pharos.watch");
  });

  it("renders the env docs blocks from the shared manifest", () => {
    const workerBlock = renderWorkerInfrastructureEnvBlock();
    const operatorBlock = renderOperatorOriginAccessEnvBlock();

    expect(workerBlock).toContain("| `CF_ACCESS_TEAM_DOMAIN` | `string` | optional | required | - |");
    expect(workerBlock).toContain("| `OPS_UI_ORIGIN` | `string` | reserved | optional | optional |");
    expect(operatorBlock).toContain("| `SITE_API_SHARED_SECRET` | optional | - | required |");
    expect(operatorBlock).toContain("| `OPS_API_SERVICE_TOKEN_SECRET` | - | required | - |");
  });
});
