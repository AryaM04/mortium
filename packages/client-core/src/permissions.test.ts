// Tests for computing the caller's own permissions from realtime-store
// data: guild-level, channel overwrites, and the "no context" fallback.
import { describe, expect, it } from "vitest";
import { Permission } from "@mortium/shared";
import { applyDispatch, createInitialRealtimeState } from "./realtime-store.js";
import {
  buildSelfContext,
  canActOnMember,
  canManageRole,
  grantablePermissions,
  selfChannelPermissions,
  selfGuildPermissions,
} from "./permissions.js";

function baseState() {
  return applyDispatch(createInitialRealtimeState(), {
    t: "READY",
    d: {
      user: { id: "1003" },
      guilds: [
        {
          id: "1001",
          name: "Guild",
          iconKey: null,
          ownerId: "owner-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          roles: [
            {
              id: "1001",
              guildId: "1001",
              name: "@everyone",
              color: 0,
              position: 0,
              permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES).toString(),
              mentionable: true,
            },
          ],
          channels: [
            {
              id: "2001",
              guildId: "1001",
              type: "text",
              name: "general",
              topic: null,
              position: 0,
              parentId: null,
              permissionOverwrites: [
                {
                  targetId: "1003",
                  targetType: "member",
                  allow: "0",
                  deny: Permission.SEND_MESSAGES.toString(),
                },
              ],
            },
          ],
          member: {
            guildId: "1001",
            userId: "1003",
            nickname: null,
            joinedAt: "2024-01-01T00:00:00.000Z",
            roles: [],
          },
        },
      ],
      presences: [],
    },
  });
}

describe("selfGuildPermissions / selfChannelPermissions", () => {
  it("computes guild-level permissions from @everyone", () => {
    const state = baseState();
    const permissions = selfGuildPermissions(state, "1001");
    expect((permissions & Permission.VIEW_CHANNEL) !== 0n).toBe(true);
    expect((permissions & Permission.SEND_MESSAGES) !== 0n).toBe(true);
  });

  it("applies a member overwrite to channel-level permissions", () => {
    const state = baseState();
    const permissions = selfChannelPermissions(state, "2001");
    expect((permissions & Permission.VIEW_CHANNEL) !== 0n).toBe(true);
    // Denied by the member overwrite.
    expect((permissions & Permission.SEND_MESSAGES) !== 0n).toBe(false);
  });

  it("returns 0 for an unknown guild or channel", () => {
    const state = baseState();
    expect(selfGuildPermissions(state, "ghost")).toBe(0n);
    expect(selfChannelPermissions(state, "ghost")).toBe(0n);
  });
});

// A hierarchy fixture mirroring apps/server/src/modules/guilds/roles.test.ts:
// @everyone (position 0), Low (position 1, MANAGE_ROLES, held by "self"),
// High (position 2, held by nobody). The target member "2001" holds Low too.
function hierarchyState(selfIsOwner = false) {
  return applyDispatch(createInitialRealtimeState(), {
    t: "READY",
    d: {
      user: { id: "1003" },
      guilds: [
        {
          id: "1001",
          name: "Guild",
          iconKey: null,
          ownerId: selfIsOwner ? "1003" : "owner-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          roles: [
            {
              id: "1001",
              guildId: "1001",
              name: "@everyone",
              color: 0,
              position: 0,
              permissions: "0",
              mentionable: true,
              hoist: false,
            },
            {
              id: "1002",
              guildId: "1001",
              name: "Low",
              color: 0,
              position: 1,
              permissions: Permission.MANAGE_ROLES.toString(),
              mentionable: true,
              hoist: false,
            },
            {
              id: "1004",
              guildId: "1001",
              name: "High",
              color: 0,
              position: 2,
              permissions: "0",
              mentionable: true,
              hoist: false,
            },
          ],
          channels: [],
          member: {
            guildId: "1001",
            userId: "1003",
            nickname: null,
            joinedAt: "2024-01-01T00:00:00.000Z",
            roles: ["1002"],
          },
        },
      ],
      presences: [],
    },
  });
}

describe("canManageRole / canActOnMember / grantablePermissions", () => {
  it("lets the caller manage a role strictly below their highest role, not their own or above", () => {
    const state = hierarchyState();
    const context = buildSelfContext(state, "1001")!;
    const roles = state.rolesByGuild["1001"]!;
    const low = roles.find((r) => r.id === "1002")!;
    const high = roles.find((r) => r.id === "1004")!;

    expect(canManageRole(context, low)).toBe(false); // same position as the actor's highest: not strictly below
    expect(canManageRole(context, high)).toBe(false); // above the actor's highest
  });

  it("lets the owner manage any role", () => {
    const state = hierarchyState(true);
    const context = buildSelfContext(state, "1001")!;
    const high = state.rolesByGuild["1001"]!.find((r) => r.id === "1004")!;
    expect(canManageRole(context, high)).toBe(true);
  });

  it("denies managing a role without MANAGE_ROLES even if it is below the actor", () => {
    const state = applyDispatch(createInitialRealtimeState(), {
      t: "READY",
      d: {
        user: { id: "1003" },
        guilds: [
          {
            id: "1001",
            name: "Guild",
            iconKey: null,
            ownerId: "owner-1",
            createdAt: "2024-01-01T00:00:00.000Z",
            roles: [
              {
                id: "1001",
                guildId: "1001",
                name: "@everyone",
                color: 0,
                position: 0,
                permissions: "0",
                mentionable: true,
                hoist: false,
              },
              {
                id: "1002",
                guildId: "1001",
                name: "Low",
                color: 0,
                position: 1,
                permissions: "0",
                mentionable: true,
                hoist: false,
              },
            ],
            channels: [],
            member: {
              guildId: "1001",
              userId: "1003",
              nickname: null,
              joinedAt: "2024-01-01T00:00:00.000Z",
              roles: [],
            },
          },
        ],
        presences: [],
      },
    });
    const context = buildSelfContext(state, "1001")!;
    const low = state.rolesByGuild["1001"]!.find((r) => r.id === "1002")!;
    expect(canManageRole(context, low)).toBe(false);
  });

  it("lets the caller act on a member whose highest role is strictly below theirs, never the owner", () => {
    const state = hierarchyState();
    const context = buildSelfContext(state, "1001")!;
    const belowMember = {
      guildId: "1001",
      userId: "2001",
      nickname: null,
      joinedAt: "2024-01-01T00:00:00.000Z",
      roles: [],
    };
    const sameLevelMember = {
      guildId: "1001",
      userId: "2002",
      nickname: null,
      joinedAt: "2024-01-01T00:00:00.000Z",
      roles: ["1002"],
    };

    expect(canActOnMember(context, belowMember, false)).toBe(true);
    expect(canActOnMember(context, sameLevelMember, false)).toBe(false); // not strictly below
    expect(canActOnMember(context, belowMember, true)).toBe(false); // nobody can act on the owner
  });

  it("the owner can act on anyone but the owner", () => {
    const state = hierarchyState(true);
    const context = buildSelfContext(state, "1001")!;
    const anyMember = {
      guildId: "1001",
      userId: "2001",
      nickname: null,
      joinedAt: "2024-01-01T00:00:00.000Z",
      roles: ["1004"],
    };
    expect(canActOnMember(context, anyMember, false)).toBe(true);
    expect(canActOnMember(context, anyMember, true)).toBe(false);
  });

  it("grantablePermissions at guild scope equals the caller's own guild permissions", () => {
    const state = hierarchyState();
    expect(grantablePermissions(state, "1001")).toBe(selfGuildPermissions(state, "1001"));
  });

  it("returns null context for an unknown guild", () => {
    const state = hierarchyState();
    expect(buildSelfContext(state, "ghost")).toBeNull();
  });
});
