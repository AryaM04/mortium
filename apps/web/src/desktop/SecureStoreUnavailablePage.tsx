// The page that the Linux app shows when it cannot keep secrets safely:
// no system key ring, so Electron safeStorage would keep the sign-in and
// the crypto key as plain text. The app refuses that and shows the fix.
import { AuthLayout } from "../components/AuthLayout.js";

export function SecureStoreUnavailablePage({ reason }: { reason: string }) {
  return (
    <AuthLayout title="The app cannot keep your sign-in safely">
      <p role="alert" className="mb-4 text-sm" data-secure-store-unavailable>
        {reason}
      </p>
      <p className="mb-2 text-sm font-semibold">To correct the problem:</p>
      <ol className="mb-4 list-decimal pl-5 text-sm text-muted">
        <li>Install GNOME Keyring (package gnome-keyring) or KWallet.</li>
        <li>Make sure that the key ring starts with your desktop session and is unlocked.</li>
        <li>
          On a desktop other than GNOME or KDE, start the app with --password-store=gnome-libsecret
          (or --password-store=kwallet5).
        </li>
        <li>Quit the app from the tray menu, then start it again.</li>
      </ol>
    </AuthLayout>
  );
}
