// The Home page (`/app/@me`): the DM list, and the Friends page or one DM.
// A group DM also shows its member list on the right.
import { Suspense, lazy, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { DmColumn } from "../components/DmColumn.js";
import { ChatPane } from "../components/ChatPane.js";
import { useRealtime } from "../lib/useRealtime.js";
import { HOME_PATH, leftDmIds, unhideDm } from "../lib/dms.js";
import { showNotice } from "../lib/notice.js";

// The Friends page loads only when it opens, to keep the main bundle small.
const FriendsView = lazy(() => import("../components/FriendsView.js"));
const GroupDmMembers = lazy(() => import("../components/GroupDmMembers.js"));

function Loading() {
  return <div className="flex-1" style={{ backgroundColor: "var(--color-bg-main)" }} />;
}

export function HomeView({ channelId }: { channelId: string | null }) {
  const channel = useRealtime((s) => (channelId ? s.privateChannels[channelId] : undefined));
  const sessionId = useRealtime((s) => s.sessionId);
  const [, navigate] = useLocation();
  // The id of the DM that was loaded last. Only that DM can be "lost".
  const loadedChannelIdRef = useRef<string | null>(null);

  // An opened DM shows in the list again, also when the user closed it before.
  useEffect(() => {
    if (channel) {
      unhideDm(channel.id);
    }
  }, [channel?.id]);

  // The user left the group, or the owner removed the user: go back to Home.
  useEffect(() => {
    if (channel) {
      loadedChannelIdRef.current = channel.id;
      return;
    }
    if (channelId && channelId === loadedChannelIdRef.current) {
      loadedChannelIdRef.current = null;
      // The user knows about a group that the user left. Show no notice then.
      if (!leftDmIds.delete(channelId)) {
        showNotice("You are no longer in this conversation.");
      }
      navigate(HOME_PATH, { replace: true });
    } else if (channelId && sessionId) {
      // The first READY came and has no such DM.
      navigate(HOME_PATH, { replace: true });
    }
  }, [channel, channelId, sessionId, navigate]);

  return (
    <>
      <DmColumn activeChannelId={channelId} />
      {channelId ? (
        <>
          <ChatPane channelId={channelId} />
          {channel?.type === "group_dm" && (
            <Suspense fallback={null}>
              <GroupDmMembers channel={channel} />
            </Suspense>
          )}
        </>
      ) : (
        <Suspense fallback={<Loading />}>
          <FriendsView />
        </Suspense>
      )}
    </>
  );
}
