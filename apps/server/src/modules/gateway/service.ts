// The in-process gateway hub: it holds every live WebSocket session, and
// sends dispatches to the right sessions. REST services call this only
// after a database commit, never before, so a dispatch never describes a
// state that did not really happen.
//
// Four indexes make fan-out cheap:
//   sessions:      sessionId -> Session (every session, live or resumable)
//   userSessions:  userId    -> Set<sessionId> (a user's live sessions)
//   guildUsers:    guildId   -> Set<userId> (who is a member of a guild)
//   friendUsers:   userId    -> Set<userId> (accepted friends, for presence)
// REST services keep guildUsers in sync by calling addUserToGuild /
// removeUserFromGuild right after they change guild_members. The friends
// service does the same for friendUsers.
// A DM has no index: its recipients come from one small query.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  GatewayOpcode,
  hasPermission,
  Permission,
  type DispatchEventName,
  type PresenceEntry,
  type PresenceStatus,
  type VisiblePresenceStatus,
} from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { channelRecipients, channels, friendships, guildMembers } from "../../db/schema.js";
import { loadGuildPermissionData, loadOverwrites, memberChannelPermissions } from "../guilds/member-context.js";

/** How many dispatches a session keeps, so a RESUME can replay them. */
export const RESUME_BUFFER_SIZE = 500;

export interface GatewayServiceOptions {
  /** How long a disconnected session's resume buffer stays around, in ms. Default 60000. */
  resumeBufferTtlMs?: number;
}

export interface SessionInfo {
  id: string;
  userId: bigint;
  deviceId: string;
}

/** A minimal socket contract, so this module never depends on `ws` types directly. */
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface BufferedDispatch {
  seq: number;
  t: DispatchEventName;
  d: unknown;
}

interface Session {
  id: string;
  userId: bigint;
  deviceId: string;
  ws: GatewaySocket | null;
  seq: number;
  buffer: BufferedDispatch[];
  /** Set when the socket disconnects. The session is dropped once this fires. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /**
   * False until READY went out. Until then, dispatches wait in the buffer,
   * so that no dispatch arrives before READY.
   */
  ready: boolean;
}

const OPEN = 1; // WebSocket.OPEN, duplicated here to avoid an import for one constant.

export class GatewayService {
  private readonly resumeBufferTtlMs: number;
  private readonly sessions = new Map<string, Session>();
  private readonly userSessions = new Map<string, Set<string>>();
  private readonly guildUsers = new Map<string, Set<string>>();
  private readonly friendUsers = new Map<string, Set<string>>();
  private readonly presence = new Map<string, PresenceStatus>();
  /** Last TYPING_START send time per "userId:channelId" pair. */
  private readonly typingThrottle = new Map<string, number>();
  // The client sends TYPING at most once per 3 s. The server limit is lower,
  // so that network jitter cannot make the server drop a correct TYPING.
  private static readonly TYPING_THROTTLE_MS = 2500;
  private static readonly TYPING_THROTTLE_MAX_ENTRIES = 10_000;

  constructor(options: GatewayServiceOptions = {}) {
    this.resumeBufferTtlMs = options.resumeBufferTtlMs ?? 60_000;
  }

  // ---- session lifecycle ------------------------------------------------

  /** Create a new session for a freshly identified connection. */
  createSession(ws: GatewaySocket, userId: bigint, deviceId: string): SessionInfo {
    const id = randomBytes(16).toString("base64url");
    const session: Session = { id, userId, deviceId, ws, seq: 0, buffer: [], expiryTimer: null, ready: false };
    this.sessions.set(id, session);
    this.addUserSession(userId, id);
    return { id, userId, deviceId };
  }

  /**
   * Send the dispatches that waited for READY, in order. Call this right
   * after READY went out on the socket of the session.
   */
  markSessionReady(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ready) {
      return;
    }
    session.ready = true;
    for (const entry of session.buffer) {
      this.sendRaw(session, entry.seq, entry.t, entry.d);
    }
  }

  /** True when a live (non-ghost) session with this id belongs to this user. */
  hasLiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.ws !== null;
  }

  /**
   * Try to resume a session: reattach the socket and replay the dispatches
   * sent after `lastSequence`. Returns null when the session cannot be
   * resumed (unknown, wrong owner, or the requested sequence fell out of
   * the buffer), in which case the caller must send INVALID_SESSION.
   */
  resumeSession(
    sessionId: string,
    userId: bigint,
    deviceId: string,
    lastSequence: number,
    ws: GatewaySocket,
  ): { replay: BufferedDispatch[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.deviceId !== deviceId) {
      return null;
    }
    const oldestBuffered = session.buffer[0]?.seq ?? session.seq + 1;
    if (lastSequence > session.seq || lastSequence < oldestBuffered - 1) {
      // Either the client claims to have seen a dispatch we never sent, or
      // it wants dispatches that already fell out of the buffer.
      if (session.buffer.length > 0 || lastSequence !== session.seq) {
        return null;
      }
    }

    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = null;
    }
    // The old socket can stay open until it times out. Close it now, so that
    // its close cannot detach the session from the new socket later.
    if (session.ws && session.ws !== ws) {
      session.ws.close(1000, "The session resumed on another connection.");
    }
    session.ws = ws;
    // The caller sends the replay, so later dispatches can go out at once.
    session.ready = true;
    this.addUserSession(userId, sessionId);

    const replay = session.buffer.filter((entry) => entry.seq > lastSequence);
    return { replay };
  }

  /**
   * Detach a session's socket. The session (and its resume buffer) stays
   * around for `resumeBufferTtlMs` in case the client resumes; after that
   * it is dropped for good and the memory is freed.
   * Returns false and does nothing when `ws` is not the current socket of
   * the session, for example an old socket that closes after a RESUME.
   */
  disconnectSession(sessionId: string, ws: GatewaySocket): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws !== ws) {
      return false;
    }
    session.ws = null;
    // The session stays in `userSessions`, so a dispatch made while this
    // user is disconnected still reaches (and buffers on) this session:
    // that is what lets RESUME replay it later. It is removed from every
    // index only once the resume buffer's TTL actually expires, below.

    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
    }
    session.expiryTimer = setTimeout(() => {
      this.sessions.delete(sessionId);
      this.removeUserSession(session.userId, sessionId);
    }, this.resumeBufferTtlMs);
    // A timer must never keep the process alive by itself in tests.
    session.expiryTimer.unref?.();
    return true;
  }

  /** Look up who owns a session, for the caller's own bookkeeping (heartbeat, rate limit, etc). */
  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session ? { id: session.id, userId: session.userId, deviceId: session.deviceId } : undefined;
  }

  /** How many of a user's sessions have a live, connected socket right now. */
  liveSessionCount(userId: bigint): number {
    const sessionIds = this.userSessions.get(userId.toString());
    if (!sessionIds) {
      return 0;
    }
    let count = 0;
    for (const sessionId of sessionIds) {
      if (this.sessions.get(sessionId)?.ws) {
        count += 1;
      }
    }
    return count;
  }

  private addUserSession(userId: bigint, sessionId: string): void {
    const key = userId.toString();
    let set = this.userSessions.get(key);
    if (!set) {
      set = new Set();
      this.userSessions.set(key, set);
    }
    set.add(sessionId);
  }

  private removeUserSession(userId: bigint, sessionId: string): void {
    const key = userId.toString();
    const set = this.userSessions.get(key);
    if (!set) {
      return;
    }
    set.delete(sessionId);
    if (set.size === 0) {
      this.userSessions.delete(key);
    }
  }

  // ---- guild membership index --------------------------------------------

  addUserToGuild(guildId: bigint, userId: bigint): void {
    const key = guildId.toString();
    let set = this.guildUsers.get(key);
    if (!set) {
      set = new Set();
      this.guildUsers.set(key, set);
    }
    set.add(userId.toString());
  }

  removeUserFromGuild(guildId: bigint, userId: bigint): void {
    const key = guildId.toString();
    const set = this.guildUsers.get(key);
    if (!set) {
      return;
    }
    set.delete(userId.toString());
    if (set.size === 0) {
      this.guildUsers.delete(key);
    }
  }

  /** Drop the whole guild from the index, once it is deleted. */
  removeGuild(guildId: bigint): void {
    this.guildUsers.delete(guildId.toString());
  }

  /** Load the guild membership and friend indexes from the database. Call once, at startup. */
  async primeFromDatabase(db: DbClient): Promise<void> {
    const rows = await db.select({ guildId: guildMembers.guildId, userId: guildMembers.userId }).from(guildMembers);
    for (const row of rows) {
      this.addUserToGuild(row.guildId, row.userId);
    }
    const friendRows = await db
      .select({ userId: friendships.userId, otherId: friendships.otherId })
      .from(friendships)
      .where(eq(friendships.status, "accepted"));
    for (const row of friendRows) {
      this.addFriendship(row.userId, row.otherId);
    }
  }

  // ---- friend index ---------------------------------------------------------

  /** Record that two users are friends. Call it right after the friendship commits. */
  addFriendship(userA: bigint, userB: bigint): void {
    for (const [from, to] of [
      [userA, userB],
      [userB, userA],
    ] as const) {
      const key = from.toString();
      let set = this.friendUsers.get(key);
      if (!set) {
        set = new Set();
        this.friendUsers.set(key, set);
      }
      set.add(to.toString());
    }
  }

  /** Forget a friendship. Call it right after the friendship ends. */
  removeFriendship(userA: bigint, userB: bigint): void {
    for (const [from, to] of [
      [userA, userB],
      [userB, userA],
    ] as const) {
      const key = from.toString();
      const set = this.friendUsers.get(key);
      if (!set) {
        continue;
      }
      set.delete(to.toString());
      if (set.size === 0) {
        this.friendUsers.delete(key);
      }
    }
  }

  /** Every guild id a user belongs to, as tracked by the index. */
  guildsOf(userId: bigint): bigint[] {
    const key = userId.toString();
    const ids: bigint[] = [];
    for (const [guildId, users] of this.guildUsers) {
      if (users.has(key)) {
        ids.push(BigInt(guildId));
      }
    }
    return ids;
  }

  // ---- presence -----------------------------------------------------------

  /** The status a user's connections show to others: invisible looks like offline. */
  visibleStatus(userId: bigint): VisiblePresenceStatus {
    if (this.liveSessionCount(userId) === 0) {
      return "offline";
    }
    const status = this.presence.get(userId.toString()) ?? "online";
    return status === "invisible" ? "offline" : status;
  }

  /**
   * Set a user's presence and broadcast to every guild they share with
   * someone, but only when the visible status actually changed.
   */
  setPresence(userId: bigint, status: PresenceStatus): void {
    const before = this.visibleStatus(userId);
    this.presence.set(userId.toString(), status);
    const after = this.visibleStatus(userId);
    if (before !== after) {
      this.broadcastPresence(userId, after);
    }
  }

  /** Every user who can see the presence of `userId`: users who share a guild with it, and its friends. */
  private presenceAudience(userId: bigint): Set<string> {
    const self = userId.toString();
    const audience = new Set<string>();
    for (const guildId of this.guildsOf(userId)) {
      for (const otherUserId of this.guildUsers.get(guildId.toString()) ?? []) {
        audience.add(otherUserId);
      }
    }
    for (const friendId of this.friendUsers.get(self) ?? []) {
      audience.add(friendId);
    }
    audience.delete(self);
    return audience;
  }

  /** Called when a user's last session disconnects, or their first one connects. */
  private broadcastPresence(userId: bigint, status: VisiblePresenceStatus): void {
    for (const otherUserId of this.presenceAudience(userId)) {
      this.toUser(BigInt(otherUserId), "PRESENCE_UPDATE", { userId: userId.toString(), status });
    }
  }

  /**
   * Presence entries for every online user who shares a guild with `userId`,
   * or is a friend of `userId`, for READY. Presence is symmetric: a user
   * sees exactly the users who see this user.
   */
  onlinePresencesFor(userId: bigint): PresenceEntry[] {
    const entries: PresenceEntry[] = [];
    for (const otherUserId of this.presenceAudience(userId)) {
      const status = this.visibleStatus(BigInt(otherUserId));
      if (status !== "offline") {
        entries.push({ userId: otherUserId, status });
      }
    }
    return entries;
  }

  /** Tell two new friends about each other's presence. An offline user needs no message. */
  exchangePresence(userA: bigint, userB: bigint): void {
    for (const [viewer, subject] of [
      [userA, userB],
      [userB, userA],
    ] as const) {
      const status = this.visibleStatus(subject);
      if (status !== "offline") {
        this.toUser(viewer, "PRESENCE_UPDATE", { userId: subject.toString(), status });
      }
    }
  }

  /** Called on connect/disconnect so presence flips online/offline at the right time. */
  notifyConnectionCountChanged(userId: bigint): void {
    const status = this.visibleStatus(userId);
    this.broadcastPresence(userId, status);
  }

  // ---- dispatch / fan-out --------------------------------------------------

  /** True at most once per throttle period per (user, channel) pair. Also records this call as a send. */
  shouldSendTyping(userId: bigint, channelId: bigint): boolean {
    const key = `${userId.toString()}:${channelId.toString()}`;
    const now = Date.now();
    const last = this.typingThrottle.get(key) ?? 0;
    if (now - last < GatewayService.TYPING_THROTTLE_MS) {
      return false;
    }
    if (this.typingThrottle.size >= GatewayService.TYPING_THROTTLE_MAX_ENTRIES) {
      this.removeExpiredTypingEntries(now);
    }
    this.typingThrottle.set(key, now);
    return true;
  }

  /** Forget the typing throttle of a user in a channel. Call this after the user sends a message. */
  clearTyping(userId: bigint, channelId: bigint): void {
    this.typingThrottle.delete(`${userId.toString()}:${channelId.toString()}`);
  }

  /** Keep the throttle map bounded: remove the entries that no longer block a send. */
  private removeExpiredTypingEntries(now: number): void {
    for (const [key, last] of this.typingThrottle) {
      if (now - last >= GatewayService.TYPING_THROTTLE_MS) {
        this.typingThrottle.delete(key);
      }
    }
  }

  /** Send one dispatch to every live session of one user, buffering it for resume. */
  toUser(userId: bigint, t: DispatchEventName, d: unknown): void {
    const sessionIds = this.userSessions.get(userId.toString());
    if (!sessionIds) {
      return;
    }
    for (const sessionId of sessionIds) {
      this.dispatchToSession(sessionId, t, d);
    }
  }

  /** Send one dispatch to every live session of one user, except sessions on `excludeDeviceId`. */
  toUserExceptDevice(userId: bigint, excludeDeviceId: string, t: DispatchEventName, d: unknown): void {
    const sessionIds = this.userSessions.get(userId.toString());
    if (!sessionIds) {
      return;
    }
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session && session.deviceId !== excludeDeviceId) {
        this.dispatchToSession(sessionId, t, d);
      }
    }
  }

  /** Send one dispatch to every member of a guild, except `excludeUserId` when given. */
  toGuild(guildId: bigint, t: DispatchEventName, d: unknown, excludeUserId?: bigint): void {
    const users = this.guildUsers.get(guildId.toString());
    if (!users) {
      return;
    }
    const excludeKey = excludeUserId?.toString();
    for (const userId of users) {
      if (userId === excludeKey) {
        continue;
      }
      this.toUser(BigInt(userId), t, d);
    }
  }

  /**
   * Every member of `guildId` who can currently view `channelId`. The
   * server loads the guild data once and computes the permissions in
   * memory, with no queries for each member. Call this BEFORE a channel
   * delete commits, so the overwrite rows (cascaded away by the delete) are
   * still there.
   */
  async computeChannelViewers(db: DbClient, guildId: bigint, channelId: bigint): Promise<bigint[]> {
    if (!this.guildUsers.has(guildId.toString())) {
      return [];
    }
    const [data, overwrites] = await Promise.all([loadGuildPermissionData(db, guildId), loadOverwrites(db, [channelId])]);
    if (!data) {
      return [];
    }
    const channelOverwrites = overwrites.get(channelId) ?? [];
    return data.memberIds.filter((userId) =>
      hasPermission(memberChannelPermissions(data, userId, channelOverwrites), Permission.VIEW_CHANNEL),
    );
  }

  /**
   * Every user who can view a channel right now: the recipients of a DM or
   * a group DM, or the guild members who pass the permission check.
   */
  async channelViewers(db: DbClient, channelId: bigint): Promise<bigint[]> {
    const channelRows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const channel = channelRows[0];
    if (!channel) {
      return [];
    }
    if (channel.guildId === null) {
      return loadRecipientIds(db, channelId);
    }
    return this.computeChannelViewers(db, channel.guildId, channelId);
  }

  /** Send one dispatch to every user who can view a channel right now. */
  async toChannelViewers(db: DbClient, channelId: bigint, t: DispatchEventName, d: unknown): Promise<void> {
    this.toUsers(await this.channelViewers(db, channelId), t, d);
  }

  /**
   * Send one dispatch to every viewer of a channel except one user, e.g. a
   * TYPING_START that must not echo back to the person who is typing.
   */
  async toChannelViewersExcept(
    db: DbClient,
    channelId: bigint,
    excludeUserId: bigint,
    t: DispatchEventName,
    d: unknown,
  ): Promise<void> {
    const viewers = await this.channelViewers(db, channelId);
    this.toUsers(viewers.filter((userId) => userId !== excludeUserId), t, d);
  }

  /** Send one dispatch to an explicit list of users, e.g. viewers computed before a delete. */
  toUsers(userIds: bigint[], t: DispatchEventName, d: unknown): void {
    for (const userId of userIds) {
      this.toUser(userId, t, d);
    }
  }

  /**
   * Send one event to one live session, with no sequence number and no
   * resume buffering. The to-device queue uses this: its table is the
   * durable store, so a resume must not replay it. Returns false when the
   * session has no open socket.
   */
  sendToSession(sessionId: string, t: DispatchEventName, d: unknown): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.ws || session.ws.readyState !== OPEN) {
      return false;
    }
    session.ws.send(JSON.stringify({ op: GatewayOpcode.DISPATCH, t, d }));
    return true;
  }

  private dispatchToSession(sessionId: string, t: DispatchEventName, d: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.seq += 1;
    session.buffer.push({ seq: session.seq, t, d });
    if (session.buffer.length > RESUME_BUFFER_SIZE) {
      session.buffer.shift();
    }
    if (session.ready) {
      this.sendRaw(session, session.seq, t, d);
    }
  }

  private sendRaw(session: Session, seq: number, t: DispatchEventName, d: unknown): void {
    if (!session.ws || session.ws.readyState !== OPEN) {
      return;
    }
    session.ws.send(JSON.stringify({ op: GatewayOpcode.DISPATCH, t, s: seq, d }));
  }

  // ---- device / security actions -------------------------------------------

  /** Close every live session of one device, e.g. after logout or a revoke. */
  closeDevice(deviceId: string, code: number, reason = ""): void {
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && session.ws) {
        session.ws.close(code, reason);
      }
    }
  }

  /** Close every live session of one user on every device, e.g. after a password reset. */
  closeUser(userId: bigint, code: number, reason = ""): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.ws) {
        session.ws.close(code, reason);
      }
    }
  }

  /** Test/shutdown helper: how many sessions (live or resumable) are tracked. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

/** The user ids of everyone in a DM or a group DM. */
export async function loadRecipientIds(db: DbClient, channelId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ userId: channelRecipients.userId })
    .from(channelRecipients)
    .where(eq(channelRecipients.channelId, channelId));
  return rows.map((row) => row.userId);
}

export async function loadGuildIdsForUser(db: DbClient, userId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));
  return rows.map((row) => row.guildId);
}
