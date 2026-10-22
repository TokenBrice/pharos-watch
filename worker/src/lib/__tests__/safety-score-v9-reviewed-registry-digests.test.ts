import { describe, expect, it } from "vitest";
import access from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import incidents from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import mechanism from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import transfer from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import gaps from "@shared/data/safety-score-v9/evidence-gap-classifications-v1.json";
import {
  V9AuthoredEvidenceGapClassificationsEnvelopeSchema, V9EvidenceGapClassificationsV1Schema, V9EvidenceGapClassificationSchema,
} from "@shared/types/safety-score-v9-causes";
import { V9AccessLookthroughOverlaySchema } from "@shared/types/safety-score-v9-access-lookthrough";
import { V9ReviewedIncidentRegistrySchema } from "@shared/types/safety-score-v9-incidents";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "@shared/types/safety-score-v9-mechanism-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "@shared/types/safety-score-v9-transfer-overlays";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { domainDigest, compareText } from "@shared/lib/safety-score-v9/primitives";
import { computeSafetyScoreV9AccessClaimGraphReviewsDigest } from "../safety-score-v9/extension-access-lookthrough";
import { SAFETY_SCORE_V9_INCIDENT_REVIEWS_DIGEST } from "../safety-score-v9/extension-incidents";
import { SAFETY_SCORE_V9_MECHANISM_REVIEW_OVERLAYS_DIGEST } from "../safety-score-v9/extension-mechanism";
import { computeSafetyScoreV9ReviewedTransferFactsDigest } from "../safety-score-v9/extension-transfer";
import { canonicalizeReviewedRegistryDigest, createReviewedAssetRegistry, createReviewedRegistryReferenceExpander, expandReviewedRegistryReferences, reviewedRegistryDigestKey } from "@shared/lib/safety-score-v9/reviewed-registry";

