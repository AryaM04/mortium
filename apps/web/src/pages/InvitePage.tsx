// /invite/:code: a preview card with an Accept button. Signed-out
// visitors go to sign in first, then come back here.
import { useEffect, useState } from "react";
import { Redirect, useLocation, useParams } from "wouter";
import { acceptInvite, getInvitePreview } from "@mortium/client-core";
import type { InvitePreview } from "@mortium/shared";
import { session } from "../lib/session.js";
import { useSession } from "../lib/useSession.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { rememberLastLocation } from "../lib/lastLocation.js";
import { serverUrl } from "../lib/server-url.js";
import { CardPage } from "../components/AuthLayout.js";

export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const status = useSession((s) => s.status);
  const [, navigate] = useLocation();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status !== "signedIn") return;
    let cancelled = false;
    getInvitePreview(session.apiClient, code)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [status, code]);

  if (status === "loading") {
    return null;
  }
  if (status === "signedOut") {
    return <Redirect to={`/login?redirect=${encodeURIComponent(`/invite/${code}`)}`} />;
  }

  async function handleAccept() {
    setPending(true);
    setError(null);
    try {
      const result = await acceptInvite(session.apiClient, code);
      realtimeStore.getState().applyDispatch({ t: "GUILD_CREATE", d: result.guild });
      const firstChannel = result.guild.channels.find((c) => c.type !== "category");
      if (firstChannel) {
        rememberLastLocation(result.guild.id, firstChannel.id);
        navigate(`/app/${result.guild.id}/${firstChannel.id}`);
      } else {
        navigate(`/app/${result.guild.id}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <CardPage>
      {error && !preview && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
      {preview && (
        <>
          <p className="mb-1 text-sm text-muted">You have been invited to join</p>
          <div className="mb-4 flex items-center gap-3">
            {preview.guild.iconKey ? (
              <img
                src={serverUrl(`/api/v1/icons/${preview.guild.id}/${preview.guild.iconKey}`)}
                alt=""
                className="h-12 w-12 rounded-[12px] object-cover"
              />
            ) : (
              <div className="h-12 w-12 rounded-[12px] border border-line-strong bg-hover" />
            )}
            <div>
              <div className="font-semibold">{preview.guild.name}</div>
              <div className="text-sm text-muted">
                {preview.memberCount} member{preview.memberCount === 1 ? "" : "s"}
              </div>
            </div>
          </div>
          {error && (
            <p role="alert" className="mb-4 text-sm text-danger-text">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={handleAccept}
            className="btn btn-primary w-full"
          >
            {pending ? "Joining..." : "Accept"}
          </button>
        </>
      )}
    </CardPage>
  );
}
