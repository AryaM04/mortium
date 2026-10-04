// The "New group DM" dialog: pick up to 9 friends. One friend opens the
// 1:1 DM. Two or more make a new group DM.
import { useLocation } from "wouter";
import { openDm } from "@mortium/client-core";
import { MAX_GROUP_DM_MEMBERS } from "@mortium/shared";
import { PickFriendsDialog } from "./PickFriendsDialog.js";
import { session } from "../lib/session.js";
import { dmPath, rememberDm, unhideDm } from "../lib/dms.js";

export default function NewGroupDmDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <PickFriendsDialog
      title="New group DM"
      confirmLabel="Create"
      max={MAX_GROUP_DM_MEMBERS - 1}
      onClose={onClose}
      onConfirm={async (userIds) => {
        const channel = await openDm(session.apiClient, userIds);
        rememberDm(channel);
        unhideDm(channel.id);
        navigate(dmPath(channel.id));
      }}
    />
  );
}
