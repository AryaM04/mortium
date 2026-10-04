// Typed REST wrapper for the voice TURN credentials route. Voice join,
// leave, state and signal go over the gateway, not REST (see
// docs/concepts/voice.md).
import { turnCredentialsResponseSchema, type TurnCredentialsResponse } from "@mortium/shared";
import type { ApiClient } from "./api.js";

export function getTurnCredentials(api: ApiClient): Promise<TurnCredentialsResponse> {
  return api.request<TurnCredentialsResponse>("GET", "/voice/turn-credentials", {
    schema: turnCredentialsResponseSchema,
  });
}
