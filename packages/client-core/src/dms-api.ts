// Typed REST wrappers for DMs and group DMs. Thin calls into the shared
// `ApiClient`, parsed with the shared zod schemas. A "close DM" has no
// route: the client hides the DM on its own and keeps the history.
import {
  createDmRequestSchema,
  dmChannelSchema,
  listDmChannelsResponseSchema,
  updateGroupDmRequestSchema,
  type DmChannelJson,
  type UpdateGroupDmRequest,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";

/** One id opens (or finds) the 1:1 DM. Two to nine ids make a new group DM. */
export function openDm(api: ApiClient, recipientIds: string[]): Promise<DmChannelJson> {
  const body = createDmRequestSchema.parse({ recipientIds });
  return api.request<DmChannelJson>("POST", "/users/@me/channels", { body, schema: dmChannelSchema });
}

export async function listDmChannels(api: ApiClient): Promise<DmChannelJson[]> {
  const result = await api.request("GET", "/users/@me/channels", { schema: listDmChannelsResponseSchema });
  return result.channels;
}

/** The owner of a group DM adds a friend. */
export function addDmRecipient(api: ApiClient, channelId: string, userId: string): Promise<void> {
  return api.request("PUT", `/channels/${channelId}/recipients/${userId}`);
}

/** The owner removes a person from a group DM. A person can also remove themselves, which is a leave. */
export function removeDmRecipient(api: ApiClient, channelId: string, userId: string): Promise<void> {
  return api.request("DELETE", `/channels/${channelId}/recipients/${userId}`);
}

/** Rename a group DM. Any member can do it. A null name clears the name. */
export function renameGroupDm(api: ApiClient, channelId: string, input: UpdateGroupDmRequest): Promise<DmChannelJson> {
  updateGroupDmRequestSchema.parse(input);
  return api.request<DmChannelJson>("PATCH", `/channels/${channelId}`, { body: input, schema: dmChannelSchema });
}
