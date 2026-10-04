// Grouped permission metadata for the Roles tab and the channel
// Permissions tab: which group each permission sits in, and a one-line
// plain-word description of what it does.
import { Permission, type PermissionName } from "@mortium/shared";

export interface PermissionGroup {
  label: string;
  permissions: PermissionName[];
}

export const PERMISSION_DESCRIPTIONS: Record<PermissionName, string> = {
  VIEW_CHANNEL: "Let members see this channel.",
  MANAGE_CHANNELS: "Let members create, edit and delete channels.",
  CREATE_INVITE: "Let members create invite links.",
  MANAGE_GUILD: "Let members change the server name and icon.",
  KICK_MEMBERS: "Let members remove other members from the server.",
  BAN_MEMBERS: "Let members ban other members from the server.",
  CHANGE_NICKNAME: "Let members change their own nickname.",
  MANAGE_NICKNAMES: "Let members change other members' nicknames.",
  SEND_MESSAGES: "Let members send messages.",
  READ_MESSAGE_HISTORY: "Let members read messages sent before they joined.",
  ATTACH_FILES: "Let members attach files to messages.",
  ADD_REACTIONS: "Let members add reactions to messages.",
  MENTION_EVERYONE: "Let members mention @everyone and every role.",
  MANAGE_MESSAGES: "Let members delete or pin messages from other members.",
  CONNECT: "Let members join voice channels.",
  SPEAK: "Let members speak in voice channels.",
  VIDEO: "Let members turn on their camera in voice channels.",
  STREAM: "Let members share their screen in voice channels.",
  MUTE_MEMBERS: "Let members mute other members in voice channels.",
  DEAFEN_MEMBERS: "Let members deafen other members in voice channels.",
  MOVE_MEMBERS: "Let members move other members between voice channels.",
  MANAGE_ROLES: "Let members create, edit and delete roles below their own.",
  ADMINISTRATOR: "Give members every permission, on every channel.",
};

export const PERMISSION_GROUPS: PermissionGroup[] = [
  { label: "General", permissions: ["VIEW_CHANNEL", "MANAGE_CHANNELS", "CREATE_INVITE"] },
  {
    label: "Membership",
    permissions: [
      "MANAGE_GUILD",
      "KICK_MEMBERS",
      "BAN_MEMBERS",
      "CHANGE_NICKNAME",
      "MANAGE_NICKNAMES",
    ],
  },
  {
    label: "Text",
    permissions: [
      "SEND_MESSAGES",
      "READ_MESSAGE_HISTORY",
      "ATTACH_FILES",
      "ADD_REACTIONS",
      "MENTION_EVERYONE",
      "MANAGE_MESSAGES",
    ],
  },
  {
    label: "Voice",
    permissions: [
      "CONNECT",
      "SPEAK",
      "VIDEO",
      "STREAM",
      "MUTE_MEMBERS",
      "DEAFEN_MEMBERS",
      "MOVE_MEMBERS",
    ],
  },
  { label: "Advanced", permissions: ["MANAGE_ROLES", "ADMINISTRATOR"] },
];

/** Permission groups relevant to a channel overwrite: everything but pure-guild bits. */
export const CHANNEL_PERMISSION_GROUPS: PermissionGroup[] = PERMISSION_GROUPS.map((group) => ({
  ...group,
  permissions: group.permissions.filter(
    (name) => name !== "MANAGE_GUILD" && name !== "ADMINISTRATOR",
  ),
})).filter((group) => group.permissions.length > 0);

export function permissionLabel(name: PermissionName): string {
  return name
    .split("_")
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(" ");
}

export { Permission };
