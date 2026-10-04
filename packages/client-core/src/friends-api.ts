// Typed REST wrappers for friends and blocks. Thin calls into the shared
// `ApiClient`, parsed with the shared zod schemas.
import {
  listRelationshipsResponseSchema,
  relationshipSchema,
  sendFriendRequestSchema,
  type RelationshipJson,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";

export async function listRelationships(api: ApiClient): Promise<RelationshipJson[]> {
  const result = await api.request("GET", "/users/@me/relationships", { schema: listRelationshipsResponseSchema });
  return result.relationships;
}

/**
 * Send a friend request by username. When the other user already sent a
 * request, the server accepts it, and the result has the status `accepted`.
 */
export function sendFriendRequest(api: ApiClient, username: string): Promise<RelationshipJson> {
  const body = sendFriendRequestSchema.parse({ username });
  return api.request<RelationshipJson>("POST", "/users/@me/relationships", { body, schema: relationshipSchema });
}

export function acceptFriendRequest(api: ApiClient, userId: string): Promise<RelationshipJson> {
  return api.request<RelationshipJson>("PUT", `/users/@me/relationships/${userId}`, {
    body: { action: "accept" },
    schema: relationshipSchema,
  });
}

export function blockUser(api: ApiClient, userId: string): Promise<RelationshipJson> {
  return api.request<RelationshipJson>("PUT", `/users/@me/relationships/${userId}`, {
    body: { action: "block" },
    schema: relationshipSchema,
  });
}

/** Unfriend, cancel a request, decline a request, or unblock. */
export function removeRelationship(api: ApiClient, userId: string): Promise<void> {
  return api.request("DELETE", `/users/@me/relationships/${userId}`);
}
