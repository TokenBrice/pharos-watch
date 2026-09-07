import { z } from "zod";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";

export const ContentAddressedJournalAssetIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
export const ContentAddressedJournalSafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

const SECRET_BEARING_TEXT_PATTERNS = [
  /(?:https?|wss?):\/\//i,
  /\bauthorization\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\s*[:=]/i,
  /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=/i,
] as const;

interface JournalRecordFields {
  assetId: string;
  attemptId: string;
  attemptedAtSec: number;
  completedAtSec: number;
}

interface JournalMessages {
  secretBearingText: string;
  entryTooLarge: string;
  tooManyAssets: string;
  invalidAssetId: string;
  tooManyEntriesPerAsset: string;
  assetMismatch: string;
  duplicateAttempt: string;
  aggregateTooLarge: string;
  journalIdMismatch: string;
}

interface JournalOptions<TShape extends z.ZodRawShape> {
  payloadSchema: z.ZodObject<TShape>;
  journalIdSchema: z.ZodString;
  idPrefix: string;
  domain: string;
  entryMaxBytes: number;
  aggregateMaxBytes: number;
  maxAssets: number;
  maxEntriesPerAsset: number;
  messages: JournalMessages;
  secretBearingTextPatternExtensions?: readonly RegExp[];
}

function addIssue(ctx: z.RefinementCtx, message: string, path?: (string | number)[]) {
  ctx.addIssue(path === undefined
    ? { code: "custom", message }
    : { code: "custom", path, message });
}

export function createContentAddressedJournal<TShape extends z.ZodRawShape>(
  options: JournalOptions<TShape>,
) {
  type Payload = z.output<z.ZodObject<TShape>> & JournalRecordFields;
  const secretPatterns = [
    ...SECRET_BEARING_TEXT_PATTERNS,
    ...(options.secretBearingTextPatternExtensions ?? []),
  ];
  const payloadSchema = options.payloadSchema.superRefine((record, ctx) => {
    const serialized = stableJsonStringifyV1(record);
    if (secretPatterns.some((pattern) => pattern.test(serialized))) {
      addIssue(ctx, options.messages.secretBearingText);
    }
    if (new TextEncoder().encode(serialized).byteLength > options.entryMaxBytes) {
      addIssue(ctx, options.messages.entryTooLarge);
    }
  });

  function computeId(payload: Payload): string {
    return `${options.idPrefix}${sha256Hex(stableJsonStringifyV1({
      domain: options.domain,
      payload,
    }))}`;
  }

  const recordSchema = payloadSchema
    .extend({ journalId: options.journalIdSchema })
    .strict()
    .superRefine((record, ctx) => {
      const { journalId, ...payload } = record as Record<string, unknown> & {
        journalId: string;
      };
      if (journalId !== computeId(payload as Payload)) {
        addIssue(ctx, options.messages.journalIdMismatch, ["journalId"]);
      }
    });
  type JournalRecord = z.output<typeof recordSchema> &
    JournalRecordFields & { journalId: string };

  function compareRecords(left: JournalRecord, right: JournalRecord): number {
    return left.attemptedAtSec - right.attemptedAtSec ||
      left.completedAtSec - right.completedAtSec ||
      left.attemptId.localeCompare(right.attemptId) ||
      left.journalId.localeCompare(right.journalId);
  }

  const journalByIdSchema = z
    .record(z.string(), z.array(recordSchema))
    .superRefine((journalById, ctx) => {
      const entries = Object.entries(journalById);
      if (entries.length > options.maxAssets) {
        addIssue(ctx, options.messages.tooManyAssets);
      }
      for (const [assetId, records] of entries) {
        if (!ContentAddressedJournalAssetIdSchema.safeParse(assetId).success) {
          addIssue(ctx, options.messages.invalidAssetId, [assetId]);
        }
        if (records.length > options.maxEntriesPerAsset) {
          addIssue(ctx, options.messages.tooManyEntriesPerAsset, [assetId]);
        }
        const attemptIds = new Set<string>();
        for (const [index, record] of records.entries()) {
          const candidate = record as JournalRecord;
          if (candidate.assetId !== assetId) {
            addIssue(ctx, options.messages.assetMismatch, [assetId, index, "assetId"]);
          }
          if (attemptIds.has(candidate.attemptId)) {
            addIssue(ctx, options.messages.duplicateAttempt, [assetId, index, "attemptId"]);
          }
          attemptIds.add(candidate.attemptId);
        }
      }
      if (new TextEncoder().encode(stableJsonStringifyV1(journalById)).byteLength >
        options.aggregateMaxBytes) {
        addIssue(ctx, options.messages.aggregateTooLarge);
      }
    })
    .transform((journalById) => Object.fromEntries(
      Object.entries(journalById)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([assetId, records]) => [
          assetId,
          [...records].sort((left, right) =>
            compareRecords(left as JournalRecord, right as JournalRecord)),
        ]),
    ));

  function create(value: Payload): JournalRecord {
    const payload = payloadSchema.parse(value) as Payload;
    return recordSchema.parse({
      ...payload,
      journalId: computeId(payload),
    }) as JournalRecord;
  }

  return { payloadSchema, recordSchema, journalByIdSchema, computeId, create };
}
