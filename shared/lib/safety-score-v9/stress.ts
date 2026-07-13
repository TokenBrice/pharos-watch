import type {
  V9Severity,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import {
  evaluateV9Exit,
  type V9ExitEvaluationRoute,
} from "./exit";
import { resolveV9ReasonPolicy } from "./policy";
import {
  scoreV9EvaluatedAsset,
  type V9ProductionScoreInput,
  type V9ProductionScoreTrace,
} from "./score";

const V9_PUBLIC_STRESS_STATE_DIGEST_DOMAIN = "safety-score-v9.public-stress-state.v1";

export interface V9PublicStressState {
  schemaVersion: 1;
  scoreInput: V9ProductionScoreInput;
  exitPortfolio: {
    circulatingUsd: number | null;
    portfolioStatus: "reviewed-complete" | "incomplete";
    routes: readonly V9ExitEvaluationRoute[];
  } | null;
  stateDigest: string;
}

export type V9SupportedStressShock =
  | { kind: "backing-haircut"; haircutPct: number }
  | { kind: "route-removal"; routeKey: string }
  | { kind: "control-compromise"; compromisedScore: number; severity: V9Severity; failureDomainKey: string }
  | { kind: "upstream-result-loss"; upstreamAssetId: string }
  | { kind: "common-mode-failure"; failureDomainKey: string; severity: V9Severity; materialSharePct?: number };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedStatePayload(state: Omit<V9PublicStressState, "stateDigest">) {
  return {
    ...state,
    scoreInput: {
      ...state.scoreInput,
      identity: {
        ...state.scoreInput.identity,
        sourceGenerations: Object.fromEntries(
          Object.entries(state.scoreInput.identity.sourceGenerations).sort(([left], [right]) => compareText(left, right)),
        ),
      },
    },
    exitPortfolio: state.exitPortfolio
      ? {
          ...state.exitPortfolio,
          routes: [...state.exitPortfolio.routes].sort((left, right) => compareText(left.routeKey, right.routeKey)),
        }
      : null,
  };
}

function computeV9PublicStressStateDigest(state: Omit<V9PublicStressState, "stateDigest">): string {
  return sha256Hex(
    stableJsonStringifyV1({ domain: V9_PUBLIC_STRESS_STATE_DIGEST_DOMAIN, state: normalizedStatePayload(state) }),
  );
}

export function createV9PublicStressState(
  scoreInput: V9ProductionScoreInput,
  exitPortfolio: V9PublicStressState["exitPortfolio"],
): V9PublicStressState {
  const payload = normalizedStatePayload({ schemaVersion: 1, scoreInput, exitPortfolio });
  return { ...payload, stateDigest: computeV9PublicStressStateDigest(payload) };
}

function assertStressState(state: V9PublicStressState): void {
  if (state.schemaVersion !== 1) throw new Error("Unsupported Safety Score v9 stress-state schema");
  const { stateDigest: _digest, ...payload } = state;
  const expected = computeV9PublicStressStateDigest(payload);
  if (state.stateDigest !== expected) throw new Error("Safety Score v9 stress-state digest mismatch");
}

function structuralSignal(args: {
  reason: string;
  severity: V9Severity;
  failureDomainKey: string;
  materialSharePct?: number;
}): V9StructuralSignal {
  if (!args.failureDomainKey.trim()) throw new Error("Stress failure-domain key is required");
  return {
    kind: "critical-dependency",
    severity: args.severity,
    reason: args.reason,
    ...(args.materialSharePct !== undefined ? { materialSharePct: args.materialSharePct } : {}),
    failureDomainKeys: [args.failureDomainKey],
    evidence: [],
  };
}

function validateScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`);
}

export function evaluateV9StressState(
  state: V9PublicStressState,
  envelope: V9ValidatedPolicyEnvelope,
  shock?: V9SupportedStressShock,
): V9ProductionScoreTrace {
  assertStressState(state);
  if (!shock) return scoreV9EvaluatedAsset(state.scoreInput, envelope);
  const input = structuredClone(state.scoreInput);

  switch (shock.kind) {
    case "backing-haircut": {
      validateScore(shock.haircutPct, "haircutPct");
      if (input.pillars.backing.score !== null) {
        input.pillars.backing.score *= 1 - shock.haircutPct / 100;
      }
      break;
    }
    case "route-removal": {
      if (!state.exitPortfolio) throw new Error("Route-removal shock requires an Exit portfolio");
      if (!state.exitPortfolio.routes.some((route) => route.routeKey === shock.routeKey)) {
        throw new Error(`Unknown Safety Score v9 route ${shock.routeKey}`);
      }
      const exit = evaluateV9Exit(
        {
          circulatingUsd: state.exitPortfolio.circulatingUsd,
          portfolioStatus: state.exitPortfolio.portfolioStatus,
          routes: state.exitPortfolio.routes.filter((route) => route.routeKey !== shock.routeKey),
        },
        envelope,
      );
      const stressedExitScore =
        input.pillars.exit.score === null || exit.score === null
          ? null
          : Math.min(input.pillars.exit.score, exit.score);
      input.pillars.exit = {
        ...input.pillars.exit,
        score: stressedExitScore,
        evidenceLevel: stressedExitScore === null ? "insufficient" : input.pillars.exit.evidenceLevel,
        reasons: exit.reasons.map((code) => ({
          code,
          path: `stress:route-removal:${shock.routeKey}`,
          message: resolveV9ReasonPolicy(envelope, code).reason.publicLabel,
        })),
      };
      break;
    }
    case "control-compromise": {
      validateScore(shock.compromisedScore, "compromisedScore");
      input.pillars.control.score = Math.min(input.pillars.control.score ?? 100, shock.compromisedScore);
      input.pillars.control.structuralSignals = [
        ...input.pillars.control.structuralSignals,
        structuralSignal({
          reason: `Stress compromises economic control domain ${shock.failureDomainKey}.`,
          severity: shock.severity,
          failureDomainKey: shock.failureDomainKey,
        }),
      ];
      break;
    }
    case "upstream-result-loss": {
      input.parent = { required: true, score: null, propagatedReasons: [] };
      input.dependencyReasons = [
        ...input.dependencyReasons,
        {
          code: "missing-parent-score",
          path: `stress:upstream:${shock.upstreamAssetId}`,
          message: `Required upstream ${shock.upstreamAssetId} is unavailable under stress.`,
        },
      ];
      break;
    }
    case "common-mode-failure": {
      if (
        shock.materialSharePct !== undefined &&
        (!Number.isFinite(shock.materialSharePct) || shock.materialSharePct < 0 || shock.materialSharePct > 100)
      ) {
        throw new Error("materialSharePct must be between 0 and 100");
      }
      input.dependencyStructuralSignals = [
        ...input.dependencyStructuralSignals,
        structuralSignal({
          reason: `Stress fails common mode ${shock.failureDomainKey}.`,
          severity: shock.severity,
          failureDomainKey: shock.failureDomainKey,
          ...(shock.materialSharePct !== undefined ? { materialSharePct: shock.materialSharePct } : {}),
        }),
      ];
      break;
    }
  }
  return scoreV9EvaluatedAsset(input, envelope);
}
