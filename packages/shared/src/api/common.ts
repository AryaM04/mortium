// Shared pieces used by more than one API schema.
import { z } from "zod";

/** The largest id. The database stores an id as a signed 64-bit integer. */
export const MAX_ID = 9223372036854775807n;

/** True when the text is a decimal id in the signed 64-bit range. */
export function isValidId(text: string): boolean {
  return /^[0-9]{1,19}$/.test(text) && BigInt(text) <= MAX_ID;
}

/** A snowflake ID. The wire form is a decimal string, not a JSON number. */
export const idSchema = z.string().refine(isValidId, "This is not a valid id.");

/** The shape of every error response. The code is stable; the message can change. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Set on a 429 response: how long to wait before trying again, in milliseconds. */
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
