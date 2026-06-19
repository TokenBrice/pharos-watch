import type {
  EndpointDependency,
  EndpointPublicApiAccess,
  EndpointSiteDataAccess,
} from "./definitions";

type EndpointMethod = "GET" | "HEAD" | "POST";

export type DynamicEndpointDescriptorKey =
  | "stablecoin-summary"
  | "stablecoin-reserves"
  | "stablecoin-detail"
  | "og-image"
  | "snapshot-day"
  | "snapshot-coin"
  | "discovery-candidate-dismiss"
  | "api-key-update"
  | "api-key-deactivate"
  | "api-key-rotate"
  | "api-key-request-reject"
  | "api-key-request-release-claim"
  | "admin-telegram-chat";

export interface DynamicEndpointDescriptor {
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  methods: readonly EndpointMethod[];
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
  adminRequired: boolean;
  routeDependencies: readonly EndpointDependency[];
  requestAttribution:
    | {
        routeKey: string;
        routePath: string;
      }
    | null;
}

export const DYNAMIC_ENDPOINT_DESCRIPTORS = [
  {
    key: "stablecoin-summary",
    pattern: /^\/api\/stablecoin-summary\/([^/]+)$/,
    methods: ["GET"],
    publicApiAccess: "protected",
    siteDataAccess: "allowed",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "stablecoin-summary",
      routePath: "/api/stablecoin-summary/:id",
    },
  },
  {
    key: "stablecoin-reserves",
    pattern: /^\/api\/stablecoin-reserves\/([^/]+)$/,
    methods: ["GET"],
    publicApiAccess: "protected",
    siteDataAccess: "allowed",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "stablecoin-reserves",
      routePath: "/api/stablecoin-reserves/:id",
    },
  },
  {
    key: "stablecoin-detail",
    pattern: /^\/api\/stablecoin\/([^/]+)$/,
    methods: ["GET"],
    publicApiAccess: "protected",
    siteDataAccess: "allowed",
    adminRequired: false,
    routeDependencies: ["coingeckoApiKey"],
    requestAttribution: {
      routeKey: "stablecoin-detail",
      routePath: "/api/stablecoin/:id",
    },
  },
  {
    key: "og-image",
    pattern: /^\/api\/og\//,
    methods: ["GET"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "og-image",
      routePath: "/api/og/*",
    },
  },
  {
    key: "snapshot-day",
    pattern: /^\/api\/snapshots\/(\d{4}-\d{2}-\d{2})\.json$/,
    methods: ["GET"],
    publicApiAccess: "protected",
    siteDataAccess: "allowed",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "snapshot-day",
      routePath: "/api/snapshots/:date.json",
    },
  },
  {
    key: "snapshot-coin",
    pattern: /^\/api\/snapshot\/(\d{4}-\d{2}-\d{2})\/stablecoin\/([^/]+)$/,
    methods: ["GET"],
    publicApiAccess: "protected",
    siteDataAccess: "allowed",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "snapshot-coin",
      routePath: "/api/snapshot/:date/stablecoin/:id",
    },
  },
  {
    key: "discovery-candidate-dismiss",
    pattern: /^\/api\/discovery-candidates\/(\d+)\/dismiss$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: [],
    requestAttribution: null,
  },
  {
    key: "api-key-update",
    pattern: /^\/api\/api-keys\/(\d+)\/update$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: ["apiKeyHashPepper"],
    requestAttribution: null,
  },
  {
    key: "api-key-deactivate",
    pattern: /^\/api\/api-keys\/(\d+)\/deactivate$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: [],
    requestAttribution: null,
  },
  {
    key: "api-key-rotate",
    pattern: /^\/api\/api-keys\/(\d+)\/rotate$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: ["apiKeyHashPepper"],
    requestAttribution: null,
  },
  {
    key: "api-key-request-reject",
    pattern: /^\/api\/api-key-requests-admin\/([^/]+)\/reject$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: [],
    requestAttribution: null,
  },
  {
    key: "api-key-request-release-claim",
    pattern: /^\/api\/api-key-requests-admin\/([^/]+)\/release-claim$/,
    methods: ["POST"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: [],
    requestAttribution: null,
  },
  {
    key: "admin-telegram-chat",
    pattern: /^\/api\/admin-telegram-chat\/(-?\d+)$/,
    methods: ["GET"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    routeDependencies: [],
    requestAttribution: null,
  },
] as const satisfies readonly DynamicEndpointDescriptor[];

export function findDynamicEndpointDescriptor(path: string): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.pattern.test(path)) ?? null;
}

export function getDynamicEndpointDescriptorByKey(
  key: DynamicEndpointDescriptorKey,
): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.key === key) ?? null;
}
