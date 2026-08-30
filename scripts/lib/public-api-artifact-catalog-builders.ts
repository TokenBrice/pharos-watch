import { getEndpointDefinitionByKey, type EndpointKey } from "@shared/lib/api-endpoints/definitions";
import type {
  PostmanFolderName,
  PostmanRequestConfig,
  PublicApiArtifactEndpoint,
  PUBLIC_API_ARTIFACT_TAGS,
} from "./public-api-artifact-catalog";

type PublicApiArtifactTag = (typeof PUBLIC_API_ARTIFACT_TAGS)[number];
type PostmanRequestInput = Omit<PostmanRequestConfig, "folder"> & { folder?: PostmanFolderName };

function isPostmanRequestInputArray(
  postman: PostmanRequestInput | readonly PostmanRequestInput[] | undefined,
): postman is readonly PostmanRequestInput[] {
  return Array.isArray(postman);
}

/**
 * Existing public endpoints whose response is still documented as JsonValue.
 * New endpoints fail closed in definePublicArtifact() until they either register a
 * canonical Zod response schema or are deliberately added to this debt list.
 */
export const OPENAPI_JSON_VALUE_ENDPOINT_KEYS = new Set<EndpointKey>([
  // `snapshot-day` alone stays generic, deliberately. Its producer envelope spans the
  // historical V8 shape and a very large inline V9 union, so a faithful schema would be
  // enormous and brittle while documenting little. The other five endpoints that used to
  // sit here are now typed in public-api-response-schemas.ts.
  "snapshot-day",
]);

export type PublicArtifactInput<Key extends EndpointKey> =
  Omit<PublicApiArtifactEndpoint, "path" | "security" | "postman"> & {
    key: Key;
    postman?: PostmanRequestInput | readonly PostmanRequestInput[];
  };

export const POSTMAN_FOLDER_BY_PRIMARY_TAG = {
  Health: "Getting started",
  Stablecoins: "Getting started",
  "Peg Monitoring": "Risk and market structure",
  Liquidity: "Risk and market structure",
  Risk: "Risk and market structure",
  Blacklist: "Flows, blacklist, yield, and chains",
  Flows: "Flows, blacklist, yield, and chains",
  Yield: "Flows, blacklist, yield, and chains",
  Chains: "Flows, blacklist, yield, and chains",
  "Market Structure": "Flows, blacklist, yield, and chains",
  History: "Historical data",
  Digest: "Historical data",
  Status: "Status",
  Reserves: "Risk and market structure",
} as const satisfies Record<PublicApiArtifactTag, PostmanFolderName>;

type DefinedPublicArtifact<T> = Omit<T, "postman"> & {
  postman: PostmanRequestConfig | readonly PostmanRequestConfig[];
} & Pick<PublicApiArtifactEndpoint, "path" | "security">;

export function definePublicArtifact<const T extends PublicArtifactInput<EndpointKey>>(
  artifact: T,
): DefinedPublicArtifact<T> {
  const definition = getEndpointDefinitionByKey(artifact.key);
  if (!definition || definition.adminRequired || definition.methods.length !== 1 || definition.methods[0] !== "GET") {
    throw new Error(`Public artifact endpoint "${artifact.key}" must use a non-admin GET definition`);
  }
  const intentionallyGeneric = OPENAPI_JSON_VALUE_ENDPOINT_KEYS.has(artifact.key);
  if ((artifact.responseSchema === undefined) !== intentionallyGeneric) {
    throw new Error(
      `Public artifact endpoint "${artifact.key}" must have exactly one response contract: a canonical Zod response schema or an explicit JsonValue debt entry`,
    );
  }
  const folder = POSTMAN_FOLDER_BY_PRIMARY_TAG[artifact.tags[0] as PublicApiArtifactTag];
  if (!folder) {
    throw new Error(`Public artifact endpoint "${artifact.key}" must use a mapped primary tag`);
  }
  const postman = artifact.postman;
  const withFolder = (request?: PostmanRequestInput) => ({ folder, ...request });
  const materializedPostman = (() => {
    if (isPostmanRequestInputArray(postman)) {
      return postman.map(withFolder);
    }
    return withFolder(postman);
  })();
  return {
    ...artifact,
    postman: materializedPostman,
    path: definition.path.replace(
      /:([A-Za-z][A-Za-z0-9]*)/g,
      (_match, name: string) => `{${name === "id" ? "stablecoinId" : name}}`,
    ),
    ...(definition.publicApiAccess === "exempt" ? { security: "none" } : {}),
  } as DefinedPublicArtifact<T>;
}
