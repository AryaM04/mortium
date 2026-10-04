// The gateway TYPING op: a client says it is typing in a channel, and the
// server tells the channel's other viewers, throttled to once per 3s.
import { eq } from "drizzle-orm";
import { hasPermission, Permission, DispatchEvent } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channels } from "../../db/schema.js";
import { isMessagingBlocked, isPrivateChannelType, isRecipient } from "../dms/access.js";
import type { GatewayService } from "../gateway/service.js";
import { channelPermissions, loadMemberContext } from "../guilds/member-context.js";

/**
 * Validate and forward one TYPING op. Failures are silent (no error is sent
 * back on the gateway for this op): an invalid or unauthorized request to
 * report typing is simply not forwarded.
 */
export async function handleTyping(
  db: DbClient,
  gateway: GatewayService,
  userId: bigint,
  channelId: bigint,
): Promise<void> {
  const channelRows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = channelRows[0];
  if (!channel) {
    return;
  }

  if (isPrivateChannelType(channel.type)) {
    // A DM has no roles. Every recipient can type, unless a block stops the messages.
    if (!(await isRecipient(db, channelId, userId)) || (await isMessagingBlocked(db, channel, userId))) {
      return;
    }
  } else {
    if (channel.guildId === null || channel.type !== "text") {
      return;
    }
    const context = await loadMemberContext(db, channel.guildId, userId);
    if (!context) {
      return;
    }
    const permissions = await channelPermissions(db, channelId, context);
    if (!hasPermission(permissions, Permission.VIEW_CHANNEL) || !hasPermission(permissions, Permission.SEND_MESSAGES)) {
      return;
    }
  }

  if (!gateway.shouldSendTyping(userId, channelId)) {
    return;
  }

  await gateway.toChannelViewersExcept(db, channelId, userId, DispatchEvent.TYPING_START, {
    channelId: channelId.toString(),
    userId: userId.toString(),
  });
}
