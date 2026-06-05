import { z } from "zod";

export const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an http(s) URL");

export const NonNegativeNumberSchema = z.number().finite().nonnegative();

export const PositiveNumberSchema = z.number().finite().positive();
