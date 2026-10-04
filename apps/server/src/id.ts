// One snowflake ID generator for the whole process, and the id parser for routes.
// The server runs as a single worker, so worker ID 0 is correct.
import { isValidId, SnowflakeGenerator } from "@mortium/shared";
import { AppError } from "./errors.js";

const generator = new SnowflakeGenerator(0);

/** Make one new snowflake ID, as a bigint. */
export function nextId(): bigint {
  return generator.next();
}

/** Parse an id from a route path. A text that is not a valid id gives a 404, as for an unknown id. */
export function parseId(text: string, message = "This does not exist.", code = "NOT_FOUND"): bigint {
  if (!isValidId(text)) {
    throw new AppError(404, code, message);
  }
  return BigInt(text);
}
