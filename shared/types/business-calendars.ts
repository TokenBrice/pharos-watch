import { z } from "zod";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

export const BusinessCalendarIdSchema = z.enum([
  "luxembourg-banking-target", "brazil-b3-national", "us-federal-reserve", "frankfurt-banking-target", "hong-kong-banking",
]);
export type BusinessCalendarId = z.infer<typeof BusinessCalendarIdSchema>;
export const BusinessClockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const BusinessTimezoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Expected an IANA timezone");

export const ReviewedBusinessCalendarSchema = z.strictObject({
  id: BusinessCalendarIdSchema,
  timezone: BusinessTimezoneSchema,
  coverage: z.strictObject({ from: StrictIsoDateSchema, to: StrictIsoDateSchema }),
  weekendDays: z.array(z.number().int().min(0).max(6)).min(1).max(6),
  holidays: z.array(StrictIsoDateSchema),
  sourceUrls: z.array(z.string().url()).min(1),
  reviewedAt: StrictIsoDateSchema,
  notes: z.string().min(1),
}).superRefine((calendar, ctx) => {
  if (calendar.coverage.from > calendar.coverage.to) ctx.addIssue({ code: "custom", path: ["coverage"], message: "Invalid coverage interval" });
  if (new Set(calendar.weekendDays).size !== calendar.weekendDays.length) ctx.addIssue({ code: "custom", path: ["weekendDays"], message: "Duplicate weekend" });
  if (new Set(calendar.holidays).size !== calendar.holidays.length || calendar.holidays.some((date) => date < calendar.coverage.from || date > calendar.coverage.to)) ctx.addIssue({ code: "custom", path: ["holidays"], message: "Holidays must be unique and covered" });
});
export type ReviewedBusinessCalendar = z.infer<typeof ReviewedBusinessCalendarSchema>;
