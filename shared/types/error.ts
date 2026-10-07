import { z } from "zod";

export const ErrorDescriptorSchema = z.object({
  message: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(100),
  code: z.string().max(100).optional(),
  stack: z.string().max(800).optional(),
  get cause() { return ErrorDescriptorSchema.optional(); },
  get errors() { return z.array(ErrorDescriptorSchema).max(5).optional(); },
  truncated: z.boolean().optional(),
});
export type ErrorDescriptor = z.output<typeof ErrorDescriptorSchema>;
