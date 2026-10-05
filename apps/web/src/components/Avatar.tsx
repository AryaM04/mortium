// A user's avatar image, or their initials when there is no avatar or the
// image fails to load.
import { useState } from "react";
import type { User } from "@mortium/shared";
import { serverUrl } from "../lib/server-url.js";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function Avatar({ user, size = 40 }: { user: User; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.4 };

  if (user.avatarKey && !failed) {
    return (
      <img
        src={serverUrl(`/api/v1/avatars/${user.id}/${user.avatarKey}`)}
        alt={`${user.displayName}'s avatar`}
        className="shrink-0 rounded-full object-cover"
        style={style}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-avatar font-semibold text-avatar-text"
      style={style}
      aria-hidden="true"
    >
      {initialsOf(user.displayName)}
    </div>
  );
}
