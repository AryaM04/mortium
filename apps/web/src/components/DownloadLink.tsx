// A link to the download page. The desktop apps do not show it.
import { Link } from "wouter";
import { desktopFeatures } from "../lib/platform.js";

export function DownloadLink({ onNavigate }: { onNavigate?: () => void }) {
  if (desktopFeatures()) {
    return null;
  }
  return (
    <Link href="/download" onClick={onNavigate} className="link inline-block">
      Download the desktop app
    </Link>
  );
}
