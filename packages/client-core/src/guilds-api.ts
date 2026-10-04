// Typed REST wrappers for guilds, channels, invites and members. Each
// function is a thin call into the shared `ApiClient`, parsed with the
// shared zod schemas, so the server and this client always agree on shape.
import { z } from "zod";
import {
  acceptInviteResultSchema,
  banSchema,
  channelOrderRequestSchema,
  channelSchema,
  createBanRequestSchema,
  createChannelRequestSchema,
  createGuildRequestSchema,
  createInviteRequestSchema,
  createRoleRequestSchema,
  guildMemberSchema,
  guildViewSchema,
  inviteSchema,
  invitePreviewSchema,
  putOverwriteRequestSchema,
  roleOrderRequestSchema,
  roleSchema,
  searchMembersResponseSchema,
  transferGuildRequestSchema,
  updateChannelRequestSchema,
  updateGuildRequestSchema,
  updateMemberRequestSchema,
  updateRoleRequestSchema,
  voiceModerationRequestSchema,
  type AcceptInviteResult,
  type BanJson,
  type ChannelJson,
  type ChannelOrderRequest,
  type CreateBanRequest,
  type CreateChannelRequest,
  type CreateGuildRequest,
  type CreateInviteRequest,
  type CreateRoleRequest,
  type GuildMemberJson,
  type GuildView,
  type InviteJson,
  type InvitePreview,
  type PutOverwriteRequest,
  type RoleJson,
  type RoleOrderRequest,
  type SearchMembersResponse,
  type TransferGuildRequest,
  type UpdateChannelRequest,
  type UpdateGuildRequest,
  type UpdateMemberRequest,
  type UpdateRoleRequest,
  type VoiceModerationRequest,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";

const membersPageSchema = z.object({ members: z.array(guildMemberSchema) });
const invitesListSchema = z.object({ invites: z.array(inviteSchema) });
const rolesListSchema = z.object({ roles: z.array(roleSchema) });
const bansListSchema = z.object({ bans: z.array(banSchema) });

export function createGuild(api: ApiClient, input: CreateGuildRequest): Promise<GuildView> {
  createGuildRequestSchema.parse(input);
  return api.request<GuildView>("POST", "/guilds", { body: input, schema: guildViewSchema });
}

export function getGuild(api: ApiClient, guildId: string): Promise<GuildView> {
  return api.request<GuildView>("GET", `/guilds/${guildId}`, { schema: guildViewSchema });
}

export function updateGuild(
  api: ApiClient,
  guildId: string,
  input: UpdateGuildRequest,
): Promise<GuildView> {
  updateGuildRequestSchema.parse(input);
  return api.request<GuildView>("PATCH", `/guilds/${guildId}`, {
    body: input,
    schema: guildViewSchema,
  });
}

export function deleteGuild(api: ApiClient, guildId: string): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}`);
}

export function leaveGuild(api: ApiClient, guildId: string): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}/members/@me`);
}

export function uploadGuildIcon(api: ApiClient, guildId: string, file: Blob): Promise<GuildView> {
  const contentType = file.type || "application/octet-stream";
  return api.request<GuildView>("PUT", `/guilds/${guildId}/icon`, {
    rawBody: { data: file, contentType },
    schema: guildViewSchema,
  });
}

export function removeGuildIcon(api: ApiClient, guildId: string): Promise<GuildView> {
  return api.request<GuildView>("DELETE", `/guilds/${guildId}/icon`, { schema: guildViewSchema });
}

export interface ListMembersOptions {
  after?: string;
  limit?: number;
}

/** One keyset page of a guild's members, ordered by user id. */
export function listGuildMembers(
  api: ApiClient,
  guildId: string,
  options: ListMembersOptions = {},
): Promise<{ members: GuildMemberJson[] }> {
  const query = new URLSearchParams();
  if (options.after) {
    query.set("after", options.after);
  }
  if (options.limit) {
    query.set("limit", String(options.limit));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return api.request("GET", `/guilds/${guildId}/members${suffix}`, { schema: membersPageSchema });
}

/** Case-insensitive prefix search over a guild's members, for the mention autocomplete. */
export function searchGuildMembers(
  api: ApiClient,
  guildId: string,
  q: string,
  limit = 10,
): Promise<SearchMembersResponse> {
  const query = new URLSearchParams({ q, limit: String(limit) });
  return api.request("GET", `/guilds/${guildId}/members/search?${query.toString()}`, {
    schema: searchMembersResponseSchema,
  });
}

export function createChannel(
  api: ApiClient,
  guildId: string,
  input: CreateChannelRequest,
): Promise<ChannelJson> {
  createChannelRequestSchema.parse(input);
  return api.request<ChannelJson>("POST", `/guilds/${guildId}/channels`, {
    body: input,
    schema: channelSchema,
  });
}

/** Send one bulk order request for every channel that moved in a drag-and-drop reorder. */
export function reorderChannels(
  api: ApiClient,
  guildId: string,
  input: ChannelOrderRequest,
): Promise<void> {
  channelOrderRequestSchema.parse(input);
  return api.request("PUT", `/guilds/${guildId}/channels/order`, { body: input });
}

export function updateChannel(
  api: ApiClient,
  channelId: string,
  input: UpdateChannelRequest,
): Promise<ChannelJson> {
  updateChannelRequestSchema.parse(input);
  return api.request<ChannelJson>("PATCH", `/channels/${channelId}`, {
    body: input,
    schema: channelSchema,
  });
}

export function deleteChannel(api: ApiClient, channelId: string): Promise<void> {
  return api.request("DELETE", `/channels/${channelId}`);
}

export function createInvite(
  api: ApiClient,
  channelId: string,
  input: CreateInviteRequest,
): Promise<InviteJson> {
  createInviteRequestSchema.parse(input);
  return api.request<InviteJson>("POST", `/channels/${channelId}/invites`, {
    body: input,
    schema: inviteSchema,
  });
}

export function listGuildInvites(
  api: ApiClient,
  guildId: string,
): Promise<{ invites: InviteJson[] }> {
  return api.request("GET", `/guilds/${guildId}/invites`, { schema: invitesListSchema });
}

export function getInvitePreview(api: ApiClient, code: string): Promise<InvitePreview> {
  return api.request<InvitePreview>("GET", `/invites/${code}`, { schema: invitePreviewSchema });
}

export function acceptInvite(api: ApiClient, code: string): Promise<AcceptInviteResult> {
  return api.request<AcceptInviteResult>("POST", `/invites/${code}`, {
    schema: acceptInviteResultSchema,
  });
}

export function deleteInvite(api: ApiClient, code: string): Promise<void> {
  return api.request("DELETE", `/invites/${code}`);
}

// ---- roles ----------------------------------------------------------------

export function listGuildRoles(api: ApiClient, guildId: string): Promise<{ roles: RoleJson[] }> {
  return api.request("GET", `/guilds/${guildId}/roles`, { schema: rolesListSchema });
}

export function createRole(
  api: ApiClient,
  guildId: string,
  input: Partial<CreateRoleRequest>,
): Promise<RoleJson> {
  const parsed = createRoleRequestSchema.parse(input);
  return api.request<RoleJson>("POST", `/guilds/${guildId}/roles`, {
    body: parsed,
    schema: roleSchema,
  });
}

export function updateRole(
  api: ApiClient,
  guildId: string,
  roleId: string,
  input: UpdateRoleRequest,
): Promise<RoleJson> {
  updateRoleRequestSchema.parse(input);
  return api.request<RoleJson>("PATCH", `/guilds/${guildId}/roles/${roleId}`, {
    body: input,
    schema: roleSchema,
  });
}

export function deleteRole(api: ApiClient, guildId: string, roleId: string): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}/roles/${roleId}`);
}

/** Send one bulk order request for every role that moved in a drag-and-drop reorder. */
export function reorderRoles(
  api: ApiClient,
  guildId: string,
  input: RoleOrderRequest,
): Promise<void> {
  roleOrderRequestSchema.parse(input);
  return api.request("PUT", `/guilds/${guildId}/roles/order`, { body: input });
}

// ---- member roles and nickname --------------------------------------------

export function addMemberRole(
  api: ApiClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  return api.request("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

export function removeMemberRole(
  api: ApiClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}

export function updateMember(
  api: ApiClient,
  guildId: string,
  userId: string,
  input: UpdateMemberRequest,
): Promise<void> {
  updateMemberRequestSchema.parse(input);
  return api.request("PATCH", `/guilds/${guildId}/members/${userId}`, { body: input });
}

// ---- channel permission overwrites -----------------------------------------

export function putChannelOverwrite(
  api: ApiClient,
  channelId: string,
  targetId: string,
  input: PutOverwriteRequest,
): Promise<void> {
  putOverwriteRequestSchema.parse(input);
  return api.request("PUT", `/channels/${channelId}/overwrites/${targetId}`, { body: input });
}

export function deleteChannelOverwrite(
  api: ApiClient,
  channelId: string,
  targetId: string,
  targetType: "role" | "member",
): Promise<void> {
  return api.request("DELETE", `/channels/${channelId}/overwrites/${targetId}?type=${targetType}`);
}

// ---- moderation -------------------------------------------------------------

export function kickMember(api: ApiClient, guildId: string, userId: string): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}/members/${userId}`);
}

export function banMember(
  api: ApiClient,
  guildId: string,
  userId: string,
  input: Partial<CreateBanRequest> = {},
): Promise<void> {
  const parsed = createBanRequestSchema.parse(input);
  return api.request("PUT", `/guilds/${guildId}/bans/${userId}`, { body: parsed });
}

export function unbanMember(api: ApiClient, guildId: string, userId: string): Promise<void> {
  return api.request("DELETE", `/guilds/${guildId}/bans/${userId}`);
}

export function listBans(api: ApiClient, guildId: string): Promise<{ bans: BanJson[] }> {
  return api.request("GET", `/guilds/${guildId}/bans`, { schema: bansListSchema });
}

export function applyVoiceModeration(
  api: ApiClient,
  guildId: string,
  userId: string,
  input: VoiceModerationRequest,
): Promise<void> {
  voiceModerationRequestSchema.parse(input);
  return api.request("PATCH", `/guilds/${guildId}/members/${userId}/voice`, { body: input });
}

export function transferGuildOwnership(
  api: ApiClient,
  guildId: string,
  input: TransferGuildRequest,
): Promise<void> {
  transferGuildRequestSchema.parse(input);
  return api.request("POST", `/guilds/${guildId}/transfer`, { body: input });
}
