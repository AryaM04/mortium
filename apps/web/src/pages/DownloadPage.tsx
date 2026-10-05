// The download page for the desktop app. It works when the user is signed out.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { getLatestDesktop } from "@mortium/client-core";
import type { DesktopAsset, DesktopLatestResponse, DesktopPlatform } from "@mortium/shared";
import { describeError } from "../lib/errors.js";
import { session } from "../lib/session.js";
import { CardPage } from "../components/AuthLayout.js";

interface NavigatorWithData extends Navigator {
  userAgentData?: { platform?: string };
}

function detectPlatform(): DesktopPlatform | null {
  const nav = navigator as NavigatorWithData;
  const text = (nav.userAgentData?.platform || nav.userAgent).toLowerCase();
  if (text.includes("android") || /iphone|ipad|ipod/.test(text)) return null;
  if (text.includes("win")) return "windows";
  if (text.includes("mac")) return "macos";
  if (text.includes("linux") || text.includes("x11")) return "linux";
  return null;
}

const PLATFORM_NAMES: Record<DesktopPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};
const KIND_NAMES: Record<DesktopAsset["kind"], string> = {
  installer: "Installer",
  msi: "MSI package",
  dmg: "Disk image",
  appimage: "AppImage",
  deb: "DEB package",
};
// The first kind is the main download of a platform.
const MAIN_KIND: Record<DesktopPlatform, DesktopAsset["kind"]> = {
  windows: "installer",
  macos: "dmg",
  linux: "appimage",
};

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const NOTES: Record<DesktopPlatform, string> = {
  windows:
    'Windows SmartScreen can show a warning, because the app is not signed. Select "More info", then select "Run anyway".',
  macos: 'The first time, do not double-click the app. Right-click the app, then select "Open".',
  linux: "To start the AppImage, first make it executable. Run: chmod +x mortium-*.AppImage",
};

export default function DownloadPage() {
  const [release, setRelease] = useState<DesktopLatestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getLatestDesktop(session.apiClient).then(
      (value) => active && setRelease(value),
      (reason: unknown) => active && setError(describeError(reason)),
    );
    return () => {
      active = false;
    };
  }, []);

  const detected = detectPlatform();
  const primary = release?.assets.find(
    (asset) =>
      detected !== null && asset.platform === detected && asset.kind === MAIN_KIND[detected],
  );
  const others = release ? release.assets.filter((asset) => asset !== primary) : [];
  return (
    <CardPage wide>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Download Mortium</h1>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger-text">
          {error}
        </p>
      )}
      {!release && !error && <p className="text-muted">Loading...</p>}
      {release && (
        <>
          <p className="mb-4 text-sm text-muted">
            Version {release.version}, published on{" "}
            {new Date(release.publishedAt).toLocaleDateString()}.{" "}
            <a href={release.notesUrl} className="link">
              Release notes
            </a>
          </p>
          {primary && detected && (
            <a href={primary.url} className="btn btn-primary mb-5 flex w-full py-3">
              Download for {PLATFORM_NAMES[detected]} ({formatSize(primary.size)})
            </a>
          )}
          {others.length > 0 && (
            <>
              <h2 className="mb-2 text-sm font-semibold">
                {primary ? "Other files" : "All files"}
              </h2>
              <ul className="mb-4 flex flex-col gap-1 text-sm">
                {others.map((asset) => (
                  <li key={asset.name}>
                    <a href={asset.url} className="link">
                      {PLATFORM_NAMES[asset.platform]}: {KIND_NAMES[asset.kind]} ({asset.name})
                    </a>{" "}
                    <span className="text-muted">{formatSize(asset.size)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {release.assets.length === 0 && (
            <p className="mb-4 text-sm">This version has no desktop files.</p>
          )}
        </>
      )}
      <h2 className="mb-2 text-sm font-semibold">Before you start</h2>
      <ul className="mb-4 flex list-disc flex-col gap-1 pl-5 text-sm">
        {(Object.keys(NOTES) as DesktopPlatform[]).map((platform) => (
          <li key={platform}>
            <strong>{PLATFORM_NAMES[platform]}:</strong> {NOTES[platform]}
          </li>
        ))}
        <li>The desktop app connects to a server. Enter this address: {window.location.origin}</li>
      </ul>
      <p className="text-sm text-muted">
        <Link href="/login" className="link">
          Back to sign in
        </Link>
      </p>
    </CardPage>
  );
}
