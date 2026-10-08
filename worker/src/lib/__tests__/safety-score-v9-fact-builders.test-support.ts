import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { materializeSafetyScoreV9FactSetExtension, type SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

/** Admit the ordinary fixed-input fixtures, then exercise builders without the compiler facade. */
export function factBuilderContext(
  fixed = makeV9FixedInput(),
  extension: SafetyScoreV9FactSetExtensionV2 = makeV9Extension({
    registryFingerprint: fixed.registryFingerprint,
    clockSec: fixed.clockSec,
  }),
) {
  const normalized = normalizeSafetyScoreV9CompilerInput(fixed);
  const admitted = materializeSafetyScoreV9FactSetExtension(normalized, extension);
  return createAssetBuildContext(normalized, admitted, admitted.assets[0]!,
    domainDigest("safety-score-v9.fact-builder-test-research.v1", admitted));
}
