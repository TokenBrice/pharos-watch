import { classifyChangedFiles } from "../ci/classify-deploy-changes.mjs";
import { buildGeneratedArtifactPhases } from "./automation-registry.mjs";
import {
  buildManualAdvisoryLeaves,
  buildNoncriticalTestShardCommands,
  buildValidatePrebuildLeaves,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "./validation-lanes.mjs";
import { hasTelegramLoadGuardImpact, TELEGRAM_LOAD_ADVISORY_COMMAND } from "./telegram-load-guard.mjs";

export const DISCOVERY_TARGETS = ["pr", "local-gate", "release", "maintenance"];

const PAGES_COMMAND_IDS = new Map([
  ["npm run build", "pages:build"],
  ["npm run check:feature-flag-inlining", "pages:feature-flags"],
  ["npm run seo:check", "pages:seo"],
  ["npm run check:phishing-signatures", "pages:phishing-signatures"],
  ["npm run check:classifier-sensitive-copy", "pages:classifier-copy"],
  ["npm run check:build-size", "pages:build-size"],
  ["npm run check:build-attribution", "pages:build-attribution"],
  ["npm run validate:pages-smoke", "pages:smoke"],
]);

const DOCS_COMMANDS = [
  ["docs:verified-links", "npm run check:verified-doc-links"],
  ["docs:source-paths", "npm run check:doc-source-paths"],
  ["docs:sync", "npm run check:doc-sync"],
  ["docs:agent-doc-sync", "npm run check:agent-doc-sync"],
];

function scriptId(command) {
  const script = command.match(/^npm run ([^ ]+)/)?.[1];
  if (script) return script.replaceAll(":", "-");
  return command
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function node({
  blocking = true,
  command,
  dependsOn = [],
  failedDependencyPolicy = "block",
  id,
  lane,
  order,
  phase,
  reason,
  rerun = command,
}) {
  return {
    blocking,
    command,
    dependsOn,
    failedDependencyPolicy,
    id,
    lane,
    order,
    phase,
    reason,
    rerun,
  };
}

function omittedNode(descriptor, reason) {
  return { ...descriptor, command: descriptor.command ?? null, omittedReason: reason, selected: false };
}

function expandPrebuildLeaf(leaf, { blocking }) {
  const commands = leaf.discoveryCommands ?? [
    { command: leaf.command, id: `prebuild:${scriptId(leaf.command)}` },
  ];
  return commands.map((entry, index) =>
    node({
      blocking,
      command: entry.command,
      id: entry.id,
      lane: leaf.laneId,
      order: 1000 + leaf.prebuildOrder * 10 + index,
      phase: 10,
      reason: `${leaf.blocking === false ? "Advisory" : "Blocking"} ${leaf.laneId} prebuild check`,
    }),
  );
}

function buildGeneratedNodes({ leadingBarrierOrder = 2000 } = {}) {
  return buildGeneratedArtifactPhases({ check: true }).flatMap(({ phase, artifacts }) =>
    artifacts.map((artifact, index) =>
      node({
        command: artifact.command,
        dependsOn: (artifact.dependsOn ?? []).map((id) => `generated:${id}`),
        failedDependencyPolicy: "taint",
        id: `generated:${artifact.id}`,
        lane: "generated-output-build-and-seo",
        order: leadingBarrierOrder + phase * 100 + index,
        phase: 20 + phase,
        reason: `Generated-artifact freshness phase ${phase}`,
        rerun: `npm run check:generated-artifacts -- --only=${artifact.id}`,
      }),
    ),
  );
}

function buildClassification(changedFiles, forceFullDeploy) {
  if (!forceFullDeploy) return classifyChangedFiles(changedFiles);
  return {
    changedFiles,
    deployRequired: true,
    docsOnly: false,
    pagesChanged: true,
    pagesDeployRequired: true,
    reason: "Full deploy fallback requested",
    workerChanged: true,
    workerDeployRequired: true,
  };
}

function validationSurface(classification) {
  if (classification.pagesChanged && !classification.workerChanged) return "pages";
  if (classification.workerChanged && !classification.pagesChanged) return "worker";
  return "full";
}

function addUnique(target, descriptor) {
  const existing = target.find((candidate) => candidate.id === descriptor.id);
  if (!existing) {
    target.push(descriptor);
    return;
  }
  if (existing.command !== descriptor.command) {
    throw new Error(`Discovery descriptor id ${descriptor.id} maps to multiple commands`);
  }
}

/**
 * @param {{
 *   changedFiles?: string[],
 *   forceFullDeploy?: boolean,
 *   hasUncommittedChanges?: boolean,
 *   includeSmoke?: boolean,
 *   includeWorkerSmoke?: boolean,
 *   prebuildSkipCommands?: string[],
 *   target?: string,
 * }} [options]
 */
export function buildDiscoveryPlan({
  changedFiles,
  forceFullDeploy = false,
  hasUncommittedChanges = false,
  includeSmoke = false,
  includeWorkerSmoke = false,
  prebuildSkipCommands = [],
  target = "pr",
} = {}) {
  if (!DISCOVERY_TARGETS.includes(target)) {
    throw new Error(`Unknown discovery target: ${target}. Expected one of ${DISCOVERY_TARGETS.join(", ")}`);
  }

  const classification = buildClassification(changedFiles ?? [], forceFullDeploy);
  const selected = [];
  const omitted = [];
  const localTarget = target === "local-gate";
  const maintenanceTarget = target === "maintenance";
  const releaseTarget = target === "release" || maintenanceTarget;
  const prTarget = target === "pr" || releaseTarget;
  const surface = validationSurface(classification);
  const validationSelected =
    (maintenanceTarget || !classification.docsOnly) &&
    (!localTarget || classification.deployRequired || forceFullDeploy);

  if (!localTarget || classification.deployRequired || forceFullDeploy) {
    addUnique(
      selected,
      node({
        command: "node scripts/ci/check-node-modules-fresh.mjs --strict",
        id: "preflight:node-modules",
        lane: "workspace",
        order: 0,
        phase: 0,
        reason: "Workspace install freshness prerequisite",
      }),
    );
  }

  if (classification.docsOnly && prTarget) {
    for (const [id, command] of DOCS_COMMANDS) {
      addUnique(
        selected,
        node({ command, id, lane: "docs-only", order: 4000 + selected.length, phase: 40, reason: "Required PR docs-only path" }),
      );
    }
    if (!maintenanceTarget) {
      omitted.push(
        omittedNode(
          { id: "validation:standard-path", lane: "pr", order: 9000, phase: 90 },
          "PR classifier selected the focused internal-docs path",
        ),
      );
    }
  }
  if (validationSelected) {
    const includeAdvisory = localTarget || maintenanceTarget;
    const selectedLeaves = buildValidatePrebuildLeaves({
      includeAdvisory,
      skipCommands: localTarget ? prebuildSkipCommands : [],
      surface,
    });
    const allLeaves = buildValidatePrebuildLeaves({ includeAdvisory: true, surface });
    const selectedCommands = new Set(selectedLeaves.map((leaf) => leaf.command));

    for (const leaf of selectedLeaves) {
      if (leaf.command === "npm run check:generated-artifacts") continue;
      const blocking = localTarget ? true : leaf.blocking !== false;
      for (const descriptor of expandPrebuildLeaf(leaf, { blocking })) addUnique(selected, descriptor);
    }
    for (const leaf of allLeaves) {
      if (selectedCommands.has(leaf.command) || leaf.command === "npm run check:generated-artifacts") continue;
      for (const descriptor of expandPrebuildLeaf(leaf, { blocking: false })) {
        omitted.push(omittedNode(descriptor, "Advisory prebuild check is outside this target"));
      }
    }

    if (surface !== "worker") {
      for (const descriptor of buildGeneratedNodes()) addUnique(selected, descriptor);
    }

    for (const [index, command] of buildNoncriticalTestShardCommands().entries()) {
      addUnique(
        selected,
        node({
          command,
          id: `tests:noncritical-${index + 1}`,
          lane: "unit-and-domain-tests",
          order: 4100 + index,
          phase: 40,
          reason: "Required noncritical Vitest shard",
        }),
      );
    }

    if (classification.workerChanged || forceFullDeploy) {
      addUnique(
        selected,
        node({
          command: WORKER_VALIDATE_COMMANDS[0],
          id: "worker:typecheck",
          lane: "root-and-worker-typecheck",
          order: 4200,
          phase: 40,
          reason: "Classifier-selected Worker validation",
        }),
      );
    }
  }

  const pagesSelected =
    validationSelected &&
    classification.pagesChanged &&
    (localTarget || classification.pagesDeployRequired || forceFullDeploy);
  if (pagesSelected) {
    const generatedDependencies = selected
      .filter((descriptor) => descriptor.id.startsWith("generated:"))
      .map((descriptor) => descriptor.id);
    addUnique(
      selected,
      node({
        command: PAGES_VALIDATE_COMMANDS[0],
        dependsOn: generatedDependencies,
        failedDependencyPolicy: "taint",
        id: "pages:build",
        lane: "generated-output-build-and-seo",
        order: 4000,
        phase: 40,
        reason: "Pages static-export producer",
      }),
    );
    for (const [index, command] of PAGES_VALIDATE_COMMANDS.slice(1).entries()) {
      addUnique(
        selected,
        node({
          command,
          dependsOn: ["pages:build"],
          id: PAGES_COMMAND_IDS.get(command),
          lane: "generated-output-build-and-seo",
          order: 5000 + index,
          phase: 50,
          reason: "Independent Pages out/ consumer",
        }),
      );
    }
  }

  if (prTarget) {
    addUnique(
      selected,
      node({
        command: "npm run check:gitleaks-range",
        id: "security:gitleaks-range",
        lane: "security",
        order: 4300,
        phase: 40,
        reason: "Required range-scoped PR secret scan",
      }),
    );
    if (hasUncommittedChanges) {
      addUnique(
        selected,
        node({
          command: "npm run check:gitleaks-worktree",
          dependsOn: ["security:gitleaks-range"],
          failedDependencyPolicy: "taint",
          id: "security:gitleaks-worktree",
          lane: "security",
          order: 4400,
          phase: 41,
          reason: "Diagnostic scan for uncommitted and untracked files",
        }),
      );
    }
  } else {
    omitted.push(
      omittedNode(
        { id: "security:gitleaks-range", lane: "security", order: 9001, phase: 90 },
        "The optional local merge gate does not include Gitleaks",
      ),
    );
  }

  const telegramLoadSelected = hasTelegramLoadGuardImpact(changedFiles ?? []) || forceFullDeploy;
  if (localTarget && telegramLoadSelected) {
    addUnique(
      selected,
      node({
        command: TELEGRAM_LOAD_ADVISORY_COMMAND,
        id: "local-gate:telegram-load",
        lane: "telegram-load",
        order: 4250,
        phase: 40,
        reason: "Path-selected optional local-gate Telegram load guard",
      }),
    );
  } else if (telegramLoadSelected) {
    omitted.push(
      omittedNode(
        { id: "local-gate:telegram-load", lane: "telegram-load", order: 9250, phase: 90 },
        "The Telegram load advisory belongs to the optional local-gate target",
      ),
    );
  }

  if (releaseTarget && pagesSelected) {
    for (const [index, command] of ["npm run check:build-size", "npm run check:build-attribution"].entries()) {
      addUnique(
        selected,
        node({
          command,
          dependsOn: ["pages:build"],
          id: PAGES_COMMAND_IDS.get(command),
          lane: "generated-output-build-and-seo",
          order: 5100 + index,
          phase: 50,
          reason: "Deterministic production Pages release check",
        }),
      );
    }
  } else if (pagesSelected) {
    for (const command of ["npm run check:build-size", "npm run check:build-attribution"]) {
      omitted.push(
        omittedNode(
          node({
            command,
            dependsOn: ["pages:build"],
            id: PAGES_COMMAND_IDS.get(command),
            lane: "generated-output-build-and-seo",
            order: 9100 + omitted.length,
            phase: 90,
            reason: "Production-only Pages release check",
          }),
          "Production-only check is outside this target",
        ),
      );
    }
  }

  if (releaseTarget && (classification.workerDeployRequired || forceFullDeploy)) {
    addUnique(
      selected,
      node({
        command: "npm run check:worker-package",
        id: "worker:package",
        lane: "worker-preview-and-smoke",
        order: 5200,
        phase: 50,
        reason: "Credential-free pinned Wrangler bundle proof",
      }),
    );
  } else if (classification.workerDeployRequired) {
    omitted.push(
      omittedNode(
        { id: "worker:package", lane: "worker-preview-and-smoke", order: 9200, phase: 90 },
        "Worker packaging proof is release-target only",
      ),
    );
  }

  const manualAdvisoryLeaves = buildManualAdvisoryLeaves({ surface });
  if (maintenanceTarget) {
    for (const leaf of manualAdvisoryLeaves) {
      const command = leaf.command;
      if (selected.some((descriptor) => descriptor.command === command)) continue;
      if (command === "npm run check:world-map" && selected.some((descriptor) => descriptor.id === "generated:world-map")) {
        omitted.push(
          omittedNode(
            { id: "maintenance:check-world-map", lane: "manual-advisory", order: 9400, phase: 90 },
            "The generated:world-map node already runs the same freshness check",
          ),
        );
        continue;
      }
      const consumesPagesOutput = [
        "npm run check:build-attribution",
        "npm run check:build-size",
        "npm run test:a11y",
      ].includes(command);
      const dependsOn = consumesPagesOutput ? ["pages:build"] : [];
      if (consumesPagesOutput && !selected.some((descriptor) => descriptor.id === "pages:build")) {
        omitted.push(
          omittedNode(
            {
              command,
              id: `maintenance:${scriptId(command)}`,
              lane: leaf.laneId,
              order: 9400 + omitted.length,
              phase: 90,
            },
            "Manual Pages-output advisory requires a selected Pages build",
          ),
        );
        continue;
      }
      addUnique(
        selected,
        node({
          blocking: false,
          command,
          dependsOn,
          id: `maintenance:${scriptId(command)}`,
          lane: leaf.laneId,
          order: 6000 + selected.length,
          phase: dependsOn.length > 0 ? 60 : 40,
          reason: "Maintenance-only advisory check",
        }),
      );
    }
  } else {
    for (const leaf of manualAdvisoryLeaves) {
      if (
        selected.some((descriptor) => descriptor.command === leaf.command) ||
        omitted.some((descriptor) => descriptor.command === leaf.command)
      ) {
        continue;
      }
      omitted.push(
        omittedNode(
          {
            command: leaf.command,
            id: `maintenance:${scriptId(leaf.command)}`,
            lane: leaf.laneId,
            order: 9400 + omitted.length,
            phase: 90,
          },
          "Manual advisory check is outside this target",
        ),
      );
    }
  }

  const pagesSmokeRequested = pagesSelected && (localTarget || includeSmoke || maintenanceTarget);
  if (pagesSmokeRequested) {
    addUnique(
      selected,
      node({
        blocking: localTarget || includeSmoke,
        command: PAGES_SMOKE_VALIDATE_COMMANDS[0],
        dependsOn: ["pages:build"],
        id: "pages:smoke",
        lane: "browser-and-accessibility",
        order: 7000,
        phase: 70,
        reason: localTarget ? "Default local-gate Pages smoke" : "Selected diagnostic Pages smoke",
      }),
    );
  } else if (pagesSelected) {
    omitted.push(
      omittedNode(
        { id: "pages:smoke", lane: "browser-and-accessibility", order: 9300, phase: 90 },
        "Pages smoke is outside this target",
      ),
    );
  }

  if ((includeWorkerSmoke || maintenanceTarget) && classification.workerChanged) {
    addUnique(
      selected,
      node({
        blocking: includeWorkerSmoke,
        command: WORKER_SMOKE_VALIDATE_COMMANDS[0],
        dependsOn: selected.some((descriptor) => descriptor.id === "worker:typecheck") ? ["worker:typecheck"] : [],
        id: "worker:smoke",
        lane: "worker-preview-and-smoke",
        order: 7100,
        phase: 70,
        reason: "Selected Worker smoke check",
      }),
    );
  } else if (classification.workerChanged) {
    omitted.push(
      omittedNode(
        {
          command: WORKER_SMOKE_VALIDATE_COMMANDS[0],
          id: "worker:smoke",
          lane: "worker-preview-and-smoke",
          order: 9350,
          phase: 90,
        },
        "Worker smoke was not selected for this target",
      ),
    );
  }

  if (releaseTarget) {
    for (const [id, reason] of [
      ["external:d1-migrations", "D1 mutation is intentionally external"],
      ["external:cloudflare-deploy", "Cloudflare upload and activation are intentionally external"],
      ["external:release-propagation", "Release marker and live propagation checks are intentionally external"],
    ]) {
      omitted.push(omittedNode({ id, lane: "external", order: 9900 + omitted.length, phase: 99 }, reason));
    }
  }

  selected.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  omitted.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return { classification, omitted, selected, target };
}
