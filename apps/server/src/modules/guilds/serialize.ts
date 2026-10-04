// Turn database rows into the JSON shapes the guild API sends.
import type {
  BanJson,
  ChannelJson,
  GuildJson,
  GuildMemberJson,
  GuildView,
  InviteJson,
  InvitePreview,
  OverwriteInput,
  RoleJson,
  VoiceStateJson,
} from "@mortium/shared";
import type { ChannelRow, GuildRow, RoleRow } from "./member-context.js";

export interface InviteRow {
  code: string;
  guildId: bigint;
  channelId: bigint;
  inviterId: bigint;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
}

export function toGuildJson(guild: GuildRow): GuildJson {
  return {
    id: guild.id.toString(),
    name: guild.name,
    iconKey: guild.iconKey,
    ownerId: guild.ownerId.toString(),
    createdAt: guild.createdAt.toISOString(),
  };
}

export function toRoleJson(role: RoleRow): RoleJson {
  return {
    id: role.id.toString(),
    guildId: role.guildId.toString(),
    name: role.name,
    color: role.color,
    position: role.position,
    permissions: role.permissions.toString(),
    mentionable: role.mentionable,
    hoist: role.hoist,
  };
}

export interface BanRow {
  guildId: bigint;
  userId: bigint;
  reason: string | null;
  by: bigint;
}

export function toBanJson(ban: BanRow): BanJson {
  return {
    guildId: ban.guildId.toString(),
    userId: ban.userId.toString(),
    reason: ban.reason,
    by: ban.by.toString(),
  };
}

export function toChannelJson(channel: ChannelRow, overwrites: OverwriteInput[] = []): ChannelJson {
  return {
    id: channel.id.toString(),
    guildId: (channel.guildId ?? 0n).toString(),
    type: channel.type as "text" | "voice" | "category",
    name: channel.name,
    topic: channel.topic,
    position: channel.position,
    parentId: channel.parentId?.toString() ?? null,
    lastEventId: channel.lastEventId?.toString() ?? null,
    permissionOverwrites: overwrites.map((overwrite) => ({
      targetId: overwrite.targetId.toString(),
      targetType: overwrite.targetType,
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString(),
    })),
  };
}

export interface MemberRow {
  guildId: bigint;
  userId: bigint;
  nickname: string | null;
  joinedAt: Date;
  /** Set when the row came from a join with `users`, e.g. a member list page. */
  username?: string;
  displayName?: string;
  avatarKey?: string | null;
  statusText?: string | null;
  userCreatedAt?: Date;
}

export function toMemberJson(member: MemberRow, roleIds: bigint[]): GuildMemberJson {
  return {
    guildId: member.guildId.toString(),
    userId: member.userId.toString(),
    nickname: member.nickname,
    joinedAt: member.joinedAt.toISOString(),
    roles: roleIds.map((id) => id.toString()),
    user:
      member.username !== undefined && member.displayName !== undefined && member.userCreatedAt !== undefined
        ? {
            id: member.userId.toString(),
            username: member.username,
            displayName: member.displayName,
            avatarKey: member.avatarKey ?? null,
            statusText: member.statusText ?? null,
            createdAt: member.userCreatedAt.toISOString(),
          }
        : undefined,
  };
}

export function toInviteJson(invite: InviteRow): InviteJson {
  return {
    code: invite.code,
    guildId: invite.guildId.toString(),
    channelId: invite.channelId.toString(),
    inviterId: invite.inviterId.toString(),
    maxUses: invite.maxUses,
    uses: invite.uses,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
  };
}

export interface InvitePreviewRow {
  code: string;
  guild: { id: bigint; name: string; iconKey: string | null };
  channel: { id: bigint; name: string | null };
  inviter: { id: bigint; username: string; displayName: string; avatarKey: string | null };
  memberCount: number;
  expiresAt: Date | null;
}

export function toInvitePreviewJson(preview: InvitePreviewRow): InvitePreview {
  return {
    code: preview.code,
    guild: { id: preview.guild.id.toString(), name: preview.guild.name, iconKey: preview.guild.iconKey },
    channel: { id: preview.channel.id.toString(), name: preview.channel.name },
    inviter: {
      id: preview.inviter.id.toString(),
      username: preview.inviter.username,
      displayName: preview.inviter.displayName,
      avatarKey: preview.inviter.avatarKey,
    },
    memberCount: preview.memberCount,
    expiresAt: preview.expiresAt?.toISOString() ?? null,
  };
}

export function toGuildView(
  guild: GuildRow,
  roles: RoleRow[],
  channelsList: ChannelRow[],
  member: MemberRow,
  memberRoleIds: bigint[],
  overwritesByChannel: Map<bigint, OverwriteInput[]> = new Map(),
  voiceStates: VoiceStateJson[] = [],
): GuildView {
  return {
    ...toGuildJson(guild),
    roles: roles.map(toRoleJson),
    channels: channelsList.map((channel) => toChannelJson(channel, overwritesByChannel.get(channel.id) ?? [])),
    voiceStates,
    member: toMemberJson(member, memberRoleIds),
  };
}
