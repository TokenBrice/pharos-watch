import {
  classifyPublicApiRequestSource,
  recordPublicApiRequestSource,
  resolvePublicApiRouteMetric,
} from "../../lib/request-source-attribution";

export function createRequestSourceRecorder(config: {
  request: Request;
  db: D1Database;
  execCtx: ExecutionContext;
  isAdmin: boolean;
  skip: boolean;
  pathname: string;
}): () => void {
  if (config.isAdmin || config.skip) {
    return () => {};
  }

  const route = resolvePublicApiRouteMetric(config.pathname);
  if (!route) {
    return () => {};
  }

  const source = classifyPublicApiRequestSource(config.request);
  return () => {
    config.execCtx.waitUntil(recordPublicApiRequestSource(config.db, route, source));
  };
}
