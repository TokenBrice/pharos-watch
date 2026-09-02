import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type CliValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface EvidenceProducerMode<TAsset extends string = string> {
  assets: TAsset[];
  outDir: string;
  replayPaths: string[];
}

export function parseEvidenceProducerMode<TAsset extends string = string>(
  values: CliValues,
  defaultOutDir: string,
): EvidenceProducerMode<TAsset> {
  return {
    assets: (Array.isArray(values.asset) ? values.asset.map(String) : []) as TAsset[],
    outDir: typeof values["out-dir"] === "string" ? values["out-dir"] : defaultOutDir,
    replayPaths: Array.isArray(values.replay) ? values.replay.map(String) : [],
  };
}

interface EvidenceWriteContext<TAsset extends string, TEvidence> {
  assetId: TAsset;
  evidence: TEvidence;
  outPath: string;
}

export interface EvidenceProducerHooks<TOptions extends EvidenceProducerMode<TAsset>, TAsset extends string, TTarget, TAttempt, TEvidence, TReplay> {
  options: TOptions;
  configuredAssets: readonly TAsset[];
  resolveTarget: (assetId: TAsset) => TTarget | undefined;
  unknownTargetError: (assetId: TAsset) => string;
  replay: (path: string) => Promise<TReplay> | TReplay;
  afterReplay?: (results: TReplay[]) => Promise<void> | void;
  attempts?: (target: TTarget, options: TOptions) => readonly TAttempt[];
  capture: (target: TTarget, attempt: TAttempt | undefined, options: TOptions, assetId: TAsset) => Promise<TEvidence>;
  artifactPath: (evidence: TEvidence, options: TOptions) => string;
  serialize: (evidence: TEvidence) => string | Uint8Array;
  compareExisting: (path: string, evidence: TEvidence) => void;
  onExisting: (context: EvidenceWriteContext<TAsset, TEvidence>) => void;
  beforeWrite?: (context: EvidenceWriteContext<TAsset, TEvidence>) => Promise<void> | void;
  onWritten: (context: EvidenceWriteContext<TAsset, TEvidence>) => void;
  exclusiveWrite?: boolean;
  onAttemptError?: (error: unknown, assetId: TAsset, attempt: TAttempt) => void;
  attemptsFailedError?: (error: unknown, assetId: TAsset) => string;
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

export async function runEvidenceProducer<
  TOptions extends EvidenceProducerMode<TAsset>,
  TAsset extends string,
  TTarget,
  TAttempt,
  TEvidence,
  TReplay,
>(hooks: EvidenceProducerHooks<TOptions, TAsset, TTarget, TAttempt, TEvidence, TReplay>): Promise<void> {
  const { options } = hooks;
  if (options.replayPaths.length > 0) {
    const results: TReplay[] = [];
    for (const path of options.replayPaths) results.push(await hooks.replay(path));
    await hooks.afterReplay?.(results);
    return;
  }

  const assetIds = options.assets.length > 0 ? options.assets : hooks.configuredAssets;
  for (const assetId of assetIds) {
    const target = hooks.resolveTarget(assetId);
    if (!target) throw new Error(hooks.unknownTargetError(assetId));
    const attempts = hooks.attempts?.(target, options) ?? [undefined];
    let lastError: unknown = null;
    let completed = false;

    for (const attempt of attempts) {
      try {
        const evidence = await hooks.capture(target, attempt, options, assetId);
        const outPath = resolve(hooks.artifactPath(evidence, options));
        const context = { assetId, evidence, outPath };
        if (existsSync(outPath)) {
          hooks.compareExisting(outPath, evidence);
          hooks.onExisting(context);
          completed = true;
          break;
        }

        await hooks.beforeWrite?.(context);
        mkdirSync(dirname(outPath), { recursive: true });
        if (hooks.exclusiveWrite) {
          try {
            writeFileSync(outPath, hooks.serialize(evidence), { flag: "wx" });
          } catch (error) {
            if (!isFileExistsError(error)) throw error;
            hooks.compareExisting(outPath, evidence);
            hooks.onExisting(context);
            completed = true;
            break;
          }
        } else {
          writeFileSync(outPath, hooks.serialize(evidence));
        }
        hooks.onWritten(context);
        completed = true;
        break;
      } catch (error) {
        if (!hooks.attempts || !hooks.onAttemptError || !hooks.attemptsFailedError) throw error;
        lastError = error;
        hooks.onAttemptError(error, assetId, attempt as TAttempt);
      }
    }

    if (!completed) throw new Error(hooks.attemptsFailedError?.(lastError, assetId) ?? String(lastError));
  }
}
