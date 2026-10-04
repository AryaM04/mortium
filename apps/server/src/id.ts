// One snowflake ID generator for the whole process.
// The server runs as a single worker, so worker ID 0 is correct.
import { SnowflakeGenerator } from "@mortium/shared";

const generator = new SnowflakeGenerator(0);

/** Make one new snowflake ID, as a bigint. */
export function nextId(): bigint {
  return generator.next();
}
