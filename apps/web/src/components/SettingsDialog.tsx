// The account settings dialog: display name, status text, avatar, the password, the
// security settings (encryption), and sign out. Uses the native <dialog> element, which gives us a modal,
// focus trapping and Escape-to-close for free.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { displayNameSchema } from "@mortium/shared";
import { useLocation } from "wouter";
import { FormField } from "./FormField.js";
import { Avatar } from "./Avatar.js";
import { describeError } from "../lib/errors.js";
import { useSession } from "../lib/useSession.js";
import { session } from "../lib/session.js";
import { ChangePassword } from "./ChangePassword.js";
import { DownloadLink } from "./DownloadLink.js";
import { desktopFeatures } from "../lib/platform.js";

// The notification part loads only when the dialog opens, to keep the main bundle small.
const NotificationSettings = lazy(() => import("./NotificationSettings.js"));
const MessageSettings = lazy(() => import("./MessageSettings.js"));
const SecurityDialog = lazy(() => import("./SecurityDialog.js"));
// Only the desktop app has this part: the server address and the tray setting.
const DesktopSettings = lazy(() => import("../desktop/DesktopSettings.js"));

const MAX_AVATAR_BYTES = 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const user = useSession((s) => s.user);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [statusText, setStatusText] = useState(user?.statusText ?? "");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setDisplayName(user?.displayName ?? "");
      setStatusText(user?.statusText ?? "");
      setFormError(null);
      setAvatarError(null);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, user]);

  if (!user) return null;

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const parsed = displayNameSchema.safeParse(displayName);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    setFormError(null);
    setPending(true);
    try {
      await session.store.getState().updateProfile({
        displayName: parsed.data,
        statusText: statusText.trim() === "" ? null : statusText,
      });
      onClose();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setPending(false);
    }
  }

  async function handleAvatarChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarError(null);

    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      setAvatarError("The avatar must be a PNG, JPEG or WEBP image.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError("The avatar must be at most 1 MB.");
      return;
    }

    try {
      await session.store.getState().uploadAvatar(file);
    } catch (error) {
      setAvatarError(describeError(error));
    }
  }

  async function handleRemoveAvatar() {
    setAvatarError(null);
    try {
      await session.store.getState().removeAvatar();
    } catch (error) {
      setAvatarError(describeError(error));
    }
  }

  async function handleSignOut() {
    await session.store.getState().logout();
    onClose();
    navigate("/login");
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-full max-w-sm p-6"
      aria-label="Account settings"
    >
      <h2 className="mb-4 text-lg font-semibold">Account settings</h2>

      <div className="mb-4 flex items-center gap-3">
        <Avatar user={user} size={56} />
        <div className="flex flex-col gap-1">
          <label className="cursor-pointer text-sm link">
            Change avatar
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={handleAvatarChange}
            />
          </label>
          {user.avatarKey && (
            <button type="button" onClick={handleRemoveAvatar} className="text-left text-sm link">
              Remove avatar
            </button>
          )}
        </div>
      </div>
      {avatarError && (
        <p role="alert" className="mb-4 text-sm text-danger-text">
          {avatarError}
        </p>
      )}

      {open && (
        <Suspense fallback={null}>
          <NotificationSettings />
          <MessageSettings />
          {desktopFeatures() && <DesktopSettings />}
        </Suspense>
      )}

      <div className="mb-4 text-sm">
        <DownloadLink onNavigate={onClose} />
      </div>

      <ChangePassword />

      <button type="button" onClick={() => setSecurityOpen(true)} className="mb-4 text-sm link">
        Security: devices and secure backup
      </button>
      {securityOpen && (
        <Suspense fallback={null}>
          <SecurityDialog open onClose={() => setSecurityOpen(false)} />
        </Suspense>
      )}

      <form onSubmit={handleSave}>
        <FormField
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldError}
        />
        <FormField
          label="Status text"
          placeholder="What are you up to?"
          value={statusText ?? ""}
          onChange={(e) => setStatusText(e.target.value)}
        />
        {formError && (
          <p role="alert" className="mb-4 text-sm text-danger-text">
            {formError}
          </p>
        )}
        <div className="flex justify-between gap-2">
          <button type="button" onClick={handleSignOut} className="btn btn-danger-ghost">
            Sign out
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary">
              {pending ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
