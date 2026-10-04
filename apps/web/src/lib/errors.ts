// Turn an error from client-core into text a person can read. The server
// error message is already written for people (see docs/architecture.md
// section 3), so we show it as-is when we have one.
import { ApiError } from "@mortium/client-core";

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Try again.";
}
