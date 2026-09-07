import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MintBurnFlowMethodologySection } from "./sections/core/mint-burn-flow-section";
import { PegScoreDewsTechnicalDetails } from "./sections/monitoring/pegscore-dews-technical-details";
import { YieldIntelligenceMethodologySection } from "./sections/monitoring/yield-intelligence-section";

function markupHash(Component: React.ComponentType) {
  return createHash("sha256").update(renderToStaticMarkup(<Component />)).digest("hex");
}

describe("responsive methodology diagrams", () => {
  it.each([
    ["mint/burn flow", MintBurnFlowMethodologySection, "c08833e7814d74ad18ae2a71eb39f1bfaf6293db09681ddde3142db1b91edde5"],
    ["yield intelligence", YieldIntelligenceMethodologySection, "8b6ed8b33bdd47e312a7926c23837d3b3cbce9b665b8f78b7e1d79d95160b841"],
    ["PegScore and DEWS technical", PegScoreDewsTechnicalDetails, "139d06a7f09644e981648ef98e2bbc6075efa606621f0704af63a48049f24b5d"],
  ])("preserves the exact %s markup", (_name, Component, expected) => {
    expect(markupHash(Component)).toBe(expected);
  });
});
