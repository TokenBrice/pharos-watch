import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";

export function createCanonicalGenerationCodec<PayloadShape extends z.ZodRawShape>(options: {
  payloadSchema: z.ZodObject<PayloadShape>;
  generationIdSchema: z.ZodType<string>;
  generationIdPrefix: string;
  digestPayload: (payload: z.output<z.ZodObject<PayloadShape>>) => unknown;
  mismatchMessage: string;
  maxBytes?: { limit: number; schemaMessage: string; inputMessage: string };
  parseString?: (value: string) => unknown;
  validateSerialization?: boolean;
}) {
  type Payload = z.output<z.ZodObject<PayloadShape>>;
  type Generation = Payload & { generationId: string };
  const stringify = (value: unknown) => stableJsonStringifyV1(value);
  const computeId = (payload: Payload) => `${options.generationIdPrefix}${sha256Hex(stringify(options.digestPayload(payload)))}`;
  const schema = options.payloadSchema.extend({ generationId: options.generationIdSchema }).strict().superRefine((generation, ctx) => {
    const { generationId, ...payload } = generation as Generation;
    if (generationId !== computeId(payload as Payload)) ctx.addIssue({ code: "custom", path: ["generationId"], message: options.mismatchMessage });
    if (options.maxBytes && new TextEncoder().encode(stringify(generation)).byteLength > options.maxBytes.limit) ctx.addIssue({ code: "custom", message: options.maxBytes.schemaMessage });
  });

  return {
    schema,
    computeId,
    create: (payload: Payload) => schema.parse({ ...payload, generationId: computeId(payload) }) as Generation,
    parse(value: unknown): Generation {
      if (typeof value === "string" && options.maxBytes && new TextEncoder().encode(value).byteLength > options.maxBytes.limit) throw new Error(options.maxBytes.inputMessage);
      return schema.parse(typeof value === "string" ? (options.parseString ?? JSON.parse)(value) : value) as Generation;
    },
    serialize: (generation: Generation) => stringify(options.validateSerialization ? schema.parse(generation) : generation),
  };
}
