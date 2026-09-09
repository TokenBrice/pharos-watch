import { z } from "zod";
import { fetchJsonPostWithRetry } from "./helpers";
import type { AdapterContext } from "./types";

const checkpointSchema = z.object({ sequenceNumber: z.number().int().nonnegative().safe(), timestamp: z.string().datetime() });
const moveValueSchema = z.object({ json: z.unknown(), type: z.object({ repr: z.string() }) });
const objectSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{64}$/i),
  version: z.number().int().nonnegative().safe(),
  asMoveObject: z.object({ contents: moveValueSchema }),
});
const fieldSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{64}$/i),
  name: moveValueSchema,
  value: z.union([
    z.object({ __typename: z.literal("MoveValue"), json: z.unknown(), type: z.object({ repr: z.string() }) }),
    z.object({ __typename: z.literal("MoveObject"), address: z.string(), contents: moveValueSchema }),
  ]),
});
const dynamicFieldsPageSchema = z.object({
  nodes: z.array(fieldSchema).max(50),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

export type SuiObject = z.infer<typeof objectSchema>;
export type SuiDynamicField = z.infer<typeof fieldSchema>;

const OBJECT_QUERY = `query($address: SuiAddress!, $checkpoint: UInt53!) {
  object(address: $address, atCheckpoint: $checkpoint) {
    address version asMoveObject { contents { json type { repr } } }
  }
}`;
const FIELDS_QUERY = `query($address: SuiAddress!, $checkpoint: UInt53!, $after: String) {
  object(address: $address, atCheckpoint: $checkpoint) {
    dynamicFields(first: 50, after: $after) {
      nodes { address name { json type { repr } } value {
        __typename ... on MoveValue { json type { repr } }
        ... on MoveObject { address contents { json type { repr } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Sequential, budgeted reads; all object children inherit the pinned checkpoint.
 * A cursor/page-cap failure discards the census rather than returning a partial mix.
 */
export async function createSuiCheckpointReader(
  endpoint: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  let requests = 0;
  async function query(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    if (++requests > 24) throw new Error("Sui checkpoint read budget exceeded (24 requests)");
    const result = await fetchJsonPostWithRetry<{ data?: unknown; errors?: unknown[] }>(
      endpoint, { query, variables }, signal, 10_000, ctx,
      { maxRetries: 0, maxResponseBytes: 2 * 1024 * 1024 },
    );
    if (result.errors?.length || !result.data) throw new Error(`Sui GraphQL error: ${JSON.stringify(result.errors)}`);
    return result.data;
  }
  const head = z.object({ checkpoint: checkpointSchema }).parse(await query("{ checkpoint { sequenceNumber timestamp } }")).checkpoint;
  const checkpoint = head.sequenceNumber;
  const timestamp = Date.parse(head.timestamp) / 1000;
  const now = ctx?.nowSec ?? Date.now() / 1000;
  if (timestamp < now - 120 || timestamp > now + 60) throw new Error("Sui latest checkpoint is stale or future-dated");
  if (ctx) ctx.observedBlock = { chain: "sui", number: checkpoint, timestamp };
  return {
    checkpoint, timestamp,
    async object(address: string): Promise<SuiObject> {
      return z.object({ object: objectSchema }).parse(await query(OBJECT_QUERY, { address, checkpoint })).object;
    },
    async dynamicFields(address: string): Promise<SuiDynamicField[]> {
      const fields: SuiDynamicField[] = [];
      const cursors = new Set<string>();
      const addresses = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < 8; page++) {
        const result: z.infer<typeof dynamicFieldsPageSchema> = z.object({
          object: z.object({ dynamicFields: dynamicFieldsPageSchema }),
        }).parse(await query(FIELDS_QUERY, { address, checkpoint, after })).object.dynamicFields;
        for (const field of result.nodes) {
          if (addresses.has(field.address)) throw new Error("Sui census contains a duplicate dynamic field");
          addresses.add(field.address);
          fields.push(field);
        }
        if (!result.pageInfo.hasNextPage) return fields;
        after = result.pageInfo.endCursor;
        if (!after || cursors.has(after)) throw new Error("Sui census cursor did not advance");
        cursors.add(after);
      }
      throw new Error("Sui dynamic-field census exceeds hard page cap (8 pages)");
    },
  };
}
