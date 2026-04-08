import { classifyBrowserRequestConsumer, resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import type { ApiKeyTrafficClass } from "@shared/types";
import {
  recordApiKeyRequestAttribution,
  recordWorkerRequestAttribution,
} from "../../lib/request-source-attribution";

export function createRequestSourceRecorder(config: {
  request: Request;
  db: D1Database;
  execCtx: ExecutionContext;
  isAdmin: boolean;
  isSiteProxy: boolean;
  apiKeyId: number | null;
  apiKeyTrafficClass: ApiKeyTrafficClass | null;
  requestLane: "public-api" | "site-api" | null;
  pathname: string;
}): () => void {
  if (config.isAdmin || !config.requestLane) {
    return () => {};
  }

  const route = resolveApiRequestRouteMetric(config.pathname);
  if (!route) {
    return () => {};
  }

  if (config.requestLane === "site-api") {
    if (!config.isSiteProxy) {
      return () => {};
    }

    return () => {
      config.execCtx.waitUntil(
        recordWorkerRequestAttribution(config.db, route, "site-api", "site"),
      );
    };
  }

  const consumerClass =
    config.apiKeyTrafficClass ?? classifyBrowserRequestConsumer(config.request);
  return () => {
    const attributionWrites: Promise<void>[] = [
      recordWorkerRequestAttribution(config.db, route, "public-api", consumerClass),
    ];
    if (config.apiKeyId != null) {
      attributionWrites.push(recordApiKeyRequestAttribution(config.db, config.apiKeyId));
    }
    config.execCtx.waitUntil(Promise.all(attributionWrites).then(() => {}));
  };
}
