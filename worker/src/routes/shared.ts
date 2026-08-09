import {
  getEndpointDefinitionByKey,
  type EndpointDefinitionByKey,
  type EndpointDependenciesForKey,
  type EndpointDefinition,
  type EndpointDependency,
  type EndpointKey,
  type EndpointMethod,
} from "@shared/lib/api-endpoints";
import type { CloudflareD1StatusBindings } from "../lib/env";
import type { MintBurnFreshnessConfig } from "../lib/mint-burn-health-config";
import type { TelegramCreds } from "../lib/telegram";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { FeedbackEnv } from "../api/feedback";
import type { ApiKeySelfServeEnv } from "../api/api-key-requests/types";
import type { TelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";
import type { WorkerCanaryMode } from "../lib/canary-checks";

/** Core context available to every route handler. */
export interface RouteContext {
  url: URL;
  db: D1Database;
  execCtx: ExecutionContext;
  request: Request;
  trustedAdmin: boolean;
}

export type RouteDependency = EndpointDependency;

export interface TelegramRouteFields {
  telegramWebhookSecret: string | undefined;
  telegramWebhookSecretPrevious: string | undefined;
  telegramBotToken: string | undefined;
  telegramBotTokenPrevious: string | undefined;
  telegramCreds: TelegramCreds | null;
}

export interface TelegramRecapRolloutRouteFields {
  telegramRecapRollout: TelegramRecapRolloutPolicy;
}

export interface DigestRouteFields {
  anthropicApiKey: string | null;
}

export interface FeedbackRouteFields {
  feedbackEnv: FeedbackEnv;
}

export interface ApiKeySelfServeRouteFields {
  apiKeySelfServeEnv: ApiKeySelfServeEnv;
}

export interface MintBurnFreshnessRouteFields {
  mintBurnFreshnessConfig: MintBurnFreshnessConfig;
}

export interface AlchemyRouteFields {
  alchemyApiKey: string | null;
}

export interface ApiKeysRouteFields {
  apiKeyHashPepper: string | undefined;
}

export interface CoingeckoRouteFields {
  coingeckoApiKey: string | null;
}

export interface ChainRpcRouteFields {
  chainRpcs: Map<string, ChainRpcConfig>;
}

export interface CloudflareD1StatusRouteFields {
  cloudflareD1StatusBindings: CloudflareD1StatusBindings;
}

export interface WorkerVersionRouteFields {
  workerVersion: string | null;
}

export interface WorkerStatusConfigRouteFields {
  workerCanaryMode: WorkerCanaryMode;
}

export interface RouteDependencyFieldMap {
  apiKeyHashPepper: ApiKeysRouteFields;
  alchemyApiKey: AlchemyRouteFields;
  anthropicApiKey: Pick<DigestRouteFields, "anthropicApiKey">;
  cloudflareD1StatusConfig: CloudflareD1StatusRouteFields;
  chainRpcs: ChainRpcRouteFields;
  coingeckoApiKey: CoingeckoRouteFields;
  apiKeySelfServeEnv: ApiKeySelfServeRouteFields;
  feedbackEnv: FeedbackRouteFields;
  mintBurnFreshnessConfig: MintBurnFreshnessRouteFields;
  workerStatusConfig: WorkerStatusConfigRouteFields;
  workerVersion: WorkerVersionRouteFields;
  telegram: TelegramRouteFields;
  telegramRecapRollout: TelegramRecapRolloutRouteFields;
}

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends ((value: infer I) => void)
  ? I
  : never;

type AllRouteDependencyFields = UnionToIntersection<RouteDependencyFieldMap[RouteDependency]>;

type RequiredRouteDependencyFields<Deps extends readonly RouteDependency[]> =
  [Deps[number]] extends [never]
    ? Record<never, never>
    : UnionToIntersection<RouteDependencyFieldMap[Deps[number]]>;

/** Full context shape used by generic routing internals before a route narrows its dependencies. */
export type FullRouteContext = RouteContext & Partial<AllRouteDependencyFields>;

/** Context seen by a route once its declared dependencies have been hydrated. */
export type RouteContextFor<Deps extends readonly RouteDependency[]> =
  RouteContext &
  Omit<Partial<AllRouteDependencyFields>, keyof RequiredRouteDependencyFields<Deps>> &
  RequiredRouteDependencyFields<Deps>;

export type StaticRouteHandler<K extends EndpointKey> = (context: RouteContextFor<EndpointDependenciesForKey<K>>) => Promise<Response>;

export type StaticRouteHandlerLoader<K extends EndpointKey> = () => Promise<StaticRouteHandler<K>>;

export interface StaticRouteDefinition {
  endpoint: EndpointDefinition;
  handler: (context: FullRouteContext) => Promise<Response>;
}

export interface DynamicRouteDefinition {
  pattern: RegExp;
  dependencies: readonly RouteDependency[];
  methods: readonly EndpointMethod[];
  handle: (routeCtx: FullRouteContext, match: RegExpMatchArray) => Promise<Response>;
}

export interface RouteMatch {
  endpoint?: EndpointDefinition;
  dependencies: readonly RouteDependency[];
  methods: readonly EndpointMethod[];
  handle: (routeCtx: FullRouteContext) => Promise<Response>;
}

export type DynamicRouteHandler<Deps extends readonly RouteDependency[]> = (
  routeCtx: RouteContextFor<Deps>,
  match: RegExpMatchArray,
) => Promise<Response>;

function requireEndpoint<K extends EndpointKey>(key: K): EndpointDefinitionByKey<K> {
  const endpoint = getEndpointDefinitionByKey(key);
  if (!endpoint) {
    throw new Error(`Router endpoint key "${key}" must be declared in ENDPOINT_DEFINITIONS`);
  }
  return endpoint as EndpointDefinitionByKey<K>;
}

export function defineStaticRoute<K extends EndpointKey>(key: K, handler: StaticRouteHandler<K>): StaticRouteDefinition {
  return {
    endpoint: requireEndpoint(key),
    handler: handler as StaticRouteDefinition["handler"],
  };
}

/** Keep route modules out of the isolate until their endpoint is actually invoked. */
export function defineLazyStaticRoute<K extends EndpointKey>(
  key: K,
  loadHandler: StaticRouteHandlerLoader<K>,
): StaticRouteDefinition {
  return defineStaticRoute(key, async (context) => {
    const handler = await loadHandler();
    return handler(context);
  });
}

export function defineDynamicRoute<const Deps extends readonly RouteDependency[]>(
  pattern: RegExp,
  dependencies: Deps,
  methods: readonly EndpointMethod[],
  handle: DynamicRouteHandler<Deps>,
): DynamicRouteDefinition {
  return {
    pattern,
    dependencies,
    methods,
    handle: handle as DynamicRouteDefinition["handle"],
  };
}
