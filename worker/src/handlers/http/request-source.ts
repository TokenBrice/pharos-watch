import { classifyBrowserRequestConsumer, resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import type { ApiKeyTrafficClass } from "@shared/types";
import {
  isApiKeyRequestAttributionDisabled,
  isRequestSourceAttributionDisabled,
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
  attributionDisabled?: boolean;
  apiKeyAttributionDisabled?: boolean;
}): () => void {
  if (config.isAdmin || !config.requestLane) {
    return () => {};
  }

  const route = resolveApiRequestRouteMetric(config.pathname);
  if (!route) {
    return () => {};
  }

  if (config.requestLane === "site-api") {
    if (!config.isSiteProxy || config.attributionDisabled) {
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
    const attributionWrites: Promise<void>[] = [];
    if (!config.attributionDisabled) {
      attributionWrites.push(recordWorkerRequestAttribution(config.db, route, "public-api", consumerClass));
    }
    if (config.apiKeyId != null && !config.apiKeyAttributionDisabled) {
      attributionWrites.push(recordApiKeyRequestAttribution(config.db, config.apiKeyId));
    }
    if (attributionWrites.length === 0) {
      return;
    }
    config.execCtx.waitUntil(Promise.all(attributionWrites).then(() => {}));
  };
}

export { isApiKeyRequestAttributionDisabled, isRequestSourceAttributionDisabled };
