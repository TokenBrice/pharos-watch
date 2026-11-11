import { z } from "zod";

const AdminActionAuditEntrySchema = z.object({
  id: z.number().int(),
  at: z.number(),
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  result: z.enum(["ok", "error"]),
  httpStatus: z.number().int().nullable(),
  details: z.unknown().nullable(),
});

export const AdminActionAuditLogResponseSchema = z.object({
  entries: z.array(AdminActionAuditEntrySchema),
});

export type AdminActionAuditEntry = z.output<typeof AdminActionAuditEntrySchema>;
export type AdminActionAuditLogResponse = z.output<typeof AdminActionAuditLogResponseSchema>;
