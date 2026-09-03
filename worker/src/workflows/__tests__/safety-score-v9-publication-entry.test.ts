import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { publicationImplementationFactory, publicationRunnerFactory } =
  vi.hoisted(() => ({
    publicationImplementationFactory: vi.fn(() => ({
      runSafetyScoreV9PublicationWorkflow: vi.fn(),
    })),
    publicationRunnerFactory: vi.fn(() => ({
      runSafetyScoreV9Publication: vi.fn(),
    })),
  }));

vi.mock(
  "../../lib/safety-score-v9/publication-runner",
  publicationRunnerFactory,
);

vi.mock("../safety-score-v9-publication", publicationImplementationFactory);

describe("SafetyScoreV9PublicationWorkflow entrypoint", () => {
  it("keeps the publication runner out of the initial Worker module graph", async () => {
    vi.resetModules();

    const workerModule = await import("../../index");

    expect(workerModule.SafetyScoreV9PublicationWorkflow).toBeTypeOf("function");
    expect(publicationImplementationFactory).not.toHaveBeenCalled();
    expect(publicationRunnerFactory).not.toHaveBeenCalled();
  });

  it("matches the Workflow class name configured in Wrangler", async () => {
    const { SafetyScoreV9PublicationWorkflow } = await import("../../index");
    const wranglerConfig = readFileSync(
      resolve(process.cwd(), "worker/wrangler.toml"),
      "utf8",
    );

    expect(SafetyScoreV9PublicationWorkflow.name).toBe(
      "SafetyScoreV9PublicationWorkflow",
    );
    expect(wranglerConfig).toMatch(
      /\[\[workflows\]\][\s\S]*?class_name = "SafetyScoreV9PublicationWorkflow"/,
    );
  });
});
