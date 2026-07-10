import { describe, expect, it } from "vitest";
import {
  getRuntimeEnvKeys,
  renderEnvExample,
  renderOperatorOriginAccessEnvBlock,
  renderWorkerInfrastructureEnvBlock,
} from "../env-contract";

describe("env contract manifest", () => {
  it("keeps the worker required binding order stable", () => {
    expect(getRuntimeEnvKeys("worker", "required")).toEqual([
      "CF_VERSION_METADATA",
      "DB",
      "CORS_ORIGIN",
      "GITHUB_PAT",
      "FEEDBACK_IP_SALT",
      "API_KEY_SELF_SERVE_IP_SALT",
      "API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER",
      "API_KEY_SELF_SERVE_REQUEST_PEPPER",
      "RESEND_API_KEY",
      "API_KEY_SELF_SERVE_EMAIL_FROM",
      "API_KEY_SELF_SERVE_EMAIL_REPLY_TO",
      "API_KEY_SELF_SERVE_PUBLIC_BASE_URL",
      "BANXICO_TOKEN",
    ]);
  });

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
    expect(envExample).toContain("VAULTS_FYI_API_KEY=");
    expect(envExample).toContain("VAULTS_FYI_ENABLED=");
    expect(envExample).toContain("API_KEY_SELF_SERVE_PUBLIC_BASE_URL=https://pharos.watch/api");
    expect(envExample).toContain("SITE_API_ORIGIN=https://site-api.pharos.watch");
    expect(envExample).toContain("SELECTOR_SNAPSHOT_IP_HASH_SECRET=");
  });

  it("renders the env docs blocks from the shared manifest", () => {
    const workerBlock = renderWorkerInfrastructureEnvBlock();
    const operatorBlock = renderOperatorOriginAccessEnvBlock();

    expect(workerBlock).toContain("| `CF_ACCESS_TEAM_DOMAIN` | `string` | optional | required | - |");
    expect(workerBlock).toContain("| `TELEGRAM_BOT_TOKEN_PREVIOUS` | `string` | optional | - | - |");
    expect(workerBlock).toContain("| `VAULTS_FYI_API_KEY` | `string` | optional | - | - |");
    expect(workerBlock).toContain("| `VAULTS_FYI_ENABLED` | `string` | optional | - | - |");
    expect(workerBlock).toContain("| `OPS_UI_ORIGIN` | `string` | reserved | optional | optional |");
    expect(operatorBlock).toContain("| `SITE_API_SHARED_SECRET` | optional | - | required |");
    expect(operatorBlock).toContain("| `SITE_API_ORIGIN` | - | - | required |");
    expect(operatorBlock).toContain("| `SELECTOR_SNAPSHOT_IP_HASH_SECRET` | - | - | required |");
    expect(operatorBlock).toContain("| `OPS_API_SERVICE_TOKEN_SECRET` | - | required | - |");
  });
});
