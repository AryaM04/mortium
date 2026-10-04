// Friends and blocks. Each pair of users has one row per direction in
// `friendships`. Every change to a pair runs in one transaction, under an
// advisory lock on the pair, so two requests at the same time cannot make
// a half pair. See docs/concepts/dms-and-friends.md.
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { DispatchEvent, type RelationshipJson, type RelationshipStatus } from "@mortium/shared";
import type { DbClient } from "../../db/client.js";
import { friendships, users } from "../../db/schema.js";
import { AppError } from "../../errors.js";
import type { GatewayService } from "../gateway/service.js";
import { toUserJson, type UserRow } from "../users/serialize.js";

export interface FriendsDeps {
  db: DbClient;
  gateway?: GatewayService;
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export function toRelationshipJson(status: RelationshipStatus, user: UserRow): RelationshipJson {
  return { userId: user.id.toString(), status, user: toUserJson(user, { includePrivate: false }) };
}

/** True when one of the two users blocked the other. */
export async function isBlockedEitherWay(db: DbClient, userA: bigint, userB: bigint): Promise<boolean> {
  const rows = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "blocked"),
        or(
          and(eq(friendships.userId, userA), eq(friendships.otherId, userB)),
          and(eq(friendships.userId, userB), eq(friendships.otherId, userA)),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Wait for any other change to this pair to finish. The lock ends with the transaction. */
async function lockPair(tx: Tx, userA: bigint, userB: bigint): Promise<void> {
  const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
  const key = `friendship:${low}:${high}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function loadUserOrThrow(db: DbClient | Tx, userId: bigint): Promise<UserRow> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) {
    throw new AppError(404, "USER_NOT_FOUND", "This user does not exist.");
  }
  return rows[0];
}

async function loadPair(tx: Tx, me: bigint, other: bigint) {
  const rows = await tx
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.userId, me), eq(friendships.otherId, other)),
        and(eq(friendships.userId, other), eq(friendships.otherId, me)),
      ),
    );
  return {
    mine: rows.find((row) => row.userId === me),
    theirs: rows.find((row) => row.userId === other),
  };
}

function pairCondition(me: bigint, other: bigint) {
  return or(
    and(eq(friendships.userId, me), eq(friendships.otherId, other)),
    and(eq(friendships.userId, other), eq(friendships.otherId, me)),
  );
}

export async function listRelationships(db: DbClient, userId: bigint): Promise<RelationshipJson[]> {
  const rows = await db
    .select({ status: friendships.status, user: users })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.otherId))
    .where(eq(friendships.userId, userId));
  return rows.map((row) => toRelationshipJson(row.status, row.user));
}

/** Tell both users that they are now friends. */
function announceFriendship(deps: FriendsDeps, me: UserRow, other: UserRow): void {
  const { gateway } = deps;
  if (!gateway) {
    return;
  }
  gateway.addFriendship(me.id, other.id);
  gateway.toUser(me.id, DispatchEvent.RELATIONSHIP_ADD, toRelationshipJson("accepted", other));
  gateway.toUser(other.id, DispatchEvent.RELATIONSHIP_ADD, toRelationshipJson("accepted", me));
  gateway.exchangePresence(me.id, other.id);
}

export interface RelationshipResult {
  relationship: RelationshipJson;
  /** True when this call made a new request. False when it accepted a request that was already there. */
  created: boolean;
}

/**
 * Send a friend request by username. When the other user already sent a
 * request to the caller, this accepts it. A user who blocked the caller
 * looks the same as a user who does not exist.
 */
export async function sendFriendRequest(deps: FriendsDeps, me: bigint, username: string): Promise<RelationshipResult> {
  const { db, gateway } = deps;
  const targetRows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const target = targetRows[0];
  if (!target) {
    throw new AppError(404, "USER_NOT_FOUND", "This user does not exist.");
  }
  if (target.id === me) {
    throw new AppError(400, "CANNOT_FRIEND_SELF", "You cannot send a friend request to yourself.");
  }

  const outcome = await db.transaction(async (tx) => {
    await lockPair(tx, me, target.id);
    const { mine, theirs } = await loadPair(tx, me, target.id);
    if (theirs?.status === "blocked") {
      throw new AppError(404, "USER_NOT_FOUND", "This user does not exist.");
    }
    if (mine?.status === "blocked") {
      throw new AppError(409, "USER_BLOCKED", "You blocked this user. Unblock the user first.");
    }
    if (mine?.status === "accepted") {
      throw new AppError(409, "ALREADY_FRIENDS", "You are already friends with this user.");
    }
    if (mine?.status === "pending_outgoing") {
      throw new AppError(409, "REQUEST_ALREADY_SENT", "You already sent a friend request to this user.");
    }
    if (mine?.status === "pending_incoming") {
      await tx.update(friendships).set({ status: "accepted" }).where(pairCondition(me, target.id));
      return "accepted" as const;
    }
    await tx.insert(friendships).values([
      { userId: me, otherId: target.id, status: "pending_outgoing" },
      { userId: target.id, otherId: me, status: "pending_incoming" },
    ]);
    return "pending" as const;
  });

  const selfRow = await loadUserOrThrow(db, me);
  if (outcome === "accepted") {
    announceFriendship(deps, selfRow, target);
    return { relationship: toRelationshipJson("accepted", target), created: false };
  }
  gateway?.toUser(me, DispatchEvent.RELATIONSHIP_ADD, toRelationshipJson("pending_outgoing", target));
  gateway?.toUser(target.id, DispatchEvent.RELATIONSHIP_ADD, toRelationshipJson("pending_incoming", selfRow));
  return { relationship: toRelationshipJson("pending_outgoing", target), created: true };
}

/** Accept a friend request that another user sent to the caller. */
export async function acceptFriendRequest(deps: FriendsDeps, me: bigint, otherId: bigint): Promise<RelationshipJson> {
  const { db } = deps;
  await db.transaction(async (tx) => {
    await lockPair(tx, me, otherId);
    const { mine } = await loadPair(tx, me, otherId);
    if (mine?.status !== "pending_incoming") {
      throw new AppError(404, "REQUEST_NOT_FOUND", "There is no friend request from this user.");
    }
    await tx.update(friendships).set({ status: "accepted" }).where(pairCondition(me, otherId));
  });
  const [selfRow, other] = await Promise.all([loadUserOrThrow(db, me), loadUserOrThrow(db, otherId)]);
  announceFriendship(deps, selfRow, other);
  return toRelationshipJson("accepted", other);
}

/**
 * Block a user. This removes a friendship or a pending request in both
 * directions. The blocked user gets no row. The only sign for the blocked
 * user is that a friend request to the blocker fails like a missing user.
 */
export async function blockUser(deps: FriendsDeps, me: bigint, otherId: bigint): Promise<RelationshipJson> {
  const { db, gateway } = deps;
  if (otherId === me) {
    throw new AppError(400, "CANNOT_BLOCK_SELF", "You cannot block yourself.");
  }
  const other = await loadUserOrThrow(db, otherId);

  const { wasFriend, otherRowRemoved } = await db.transaction(async (tx) => {
    await lockPair(tx, me, otherId);
    const { mine, theirs } = await loadPair(tx, me, otherId);
    await tx
      .insert(friendships)
      .values({ userId: me, otherId, status: "blocked" })
      .onConflictDoUpdate({ target: [friendships.userId, friendships.otherId], set: { status: "blocked" } });
    // Keep a block that the other user made: it is a separate fact.
    const removable = theirs !== undefined && theirs.status !== "blocked";
    if (removable) {
      await tx
        .delete(friendships)
        .where(and(eq(friendships.userId, otherId), eq(friendships.otherId, me), ne(friendships.status, "blocked")));
    }
    return { wasFriend: mine?.status === "accepted", otherRowRemoved: removable };
  });

  if (wasFriend) {
    gateway?.removeFriendship(me, otherId);
  }
  gateway?.toUser(me, DispatchEvent.RELATIONSHIP_ADD, toRelationshipJson("blocked", other));
  if (otherRowRemoved) {
    gateway?.toUser(otherId, DispatchEvent.RELATIONSHIP_REMOVE, { userId: me.toString() });
  }
  return toRelationshipJson("blocked", other);
}

/** Unfriend, cancel a request, decline a request, or unblock. */
export async function removeRelationship(deps: FriendsDeps, me: bigint, otherId: bigint): Promise<void> {
  const { db, gateway } = deps;
  const { wasFriend, otherRowRemoved } = await db.transaction(async (tx) => {
    await lockPair(tx, me, otherId);
    const { mine, theirs } = await loadPair(tx, me, otherId);
    if (!mine) {
      throw new AppError(404, "RELATIONSHIP_NOT_FOUND", "You have no relationship with this user.");
    }
    await tx.delete(friendships).where(and(eq(friendships.userId, me), eq(friendships.otherId, otherId)));
    // Never delete a block that the other user made.
    const removable = theirs !== undefined && theirs.status !== "blocked";
    if (removable) {
      await tx
        .delete(friendships)
        .where(
          and(
            eq(friendships.userId, otherId),
            eq(friendships.otherId, me),
            inArray(friendships.status, ["pending_outgoing", "pending_incoming", "accepted"]),
          ),
        );
    }
    return { wasFriend: mine.status === "accepted", otherRowRemoved: removable };
  });

  if (wasFriend) {
    gateway?.removeFriendship(me, otherId);
  }
  gateway?.toUser(me, DispatchEvent.RELATIONSHIP_REMOVE, { userId: otherId.toString() });
  if (otherRowRemoved) {
    gateway?.toUser(otherId, DispatchEvent.RELATIONSHIP_REMOVE, { userId: me.toString() });
  }
}
