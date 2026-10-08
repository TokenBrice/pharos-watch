import { parseChangedFileArgs } from "./changed-files.mts";

/** CI coverage selection must use event refs, never a moving remote or merge checkout. */
export function parseCriticalCoverageRefs(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const refs = parseChangedFileArgs(argv, {
    ...env,
    PR_BASE_SHA: env.PR_BASE_SHA || env.GITHUB_BASE_SHA || env.CRITICAL_COVERAGE_COMPARE_REF || (env.GITHUB_ACTIONS ? "<missing-base>" : "origin/main"),
    PR_HEAD_SHA: env.PR_HEAD_SHA || env.GITHUB_HEAD_SHA || (env.GITHUB_ACTIONS ? "<missing-head>" : "HEAD"),
  });
  if (env.GITHUB_ACTIONS && (
    !refs.base.trim() || !refs.head.trim()
    || refs.base === "<missing-base>" || refs.head === "<missing-head>"
  )) {
    throw new Error("GitHub Actions critical coverage requires frozen base and head refs (PR_BASE_SHA and PR_HEAD_SHA or --base and --head).");
  }
  return refs;
}
