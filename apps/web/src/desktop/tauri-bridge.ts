// The desktop bridge of the Tauri app (Windows, macOS). The Rust side is
// in apps/desktop-tauri/src-tauri/src. Only the Tauri app loads this file,
// so the web bundle does not include it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  decodeBase64Url,
  decodeHtml,
  readHtmlMeta,
  type DesktopBridge,
  type DesktopInit,
  type DesktopLinkPreview,
  type DesktopUpdateInfo,
} from "@mortium/shared";

/** One time limit for the page and its image, the same as the server route. */
const LINK_PREVIEW_TIMEOUT_MS = 3000;

/** A page or an image that the Rust side fetched for a link preview. */
interface FetchedResource {
  /** The URL after redirects. */
  url: string;
  contentType: string;
  /** The body, as base64url. */
  body: string;
}

async function fetchResource(url: string, kind: "page" | "image", deadline: number) {
  const resource = await invoke<FetchedResource>("link_preview_fetch", {
    url,
    kind,
    timeoutMs: Math.max(0, deadline - Date.now()),
  });
  return { ...resource, bytes: decodeBase64Url(resource.body) };
}

/** Fetch a page and its image through Rust, with the same address rules as the server route. */
async function fetchLinkPreview(url: string): Promise<DesktopLinkPreview | null> {
  const deadline = Date.now() + LINK_PREVIEW_TIMEOUT_MS;
  let page;
  try {
    page = await fetchResource(url, "page", deadline);
  } catch {
    return null;
  }
  const meta = readHtmlMeta(decodeHtml(page.bytes, page.contentType));
  let image: DesktopLinkPreview["image"];
  if (meta.image) {
    try {
      const fetched = await fetchResource(new URL(meta.image, page.url).href, "image", deadline);
      image = { bytes: fetched.bytes, mime: fetched.contentType };
    } catch {
      // A preview without its image is still a preview.
    }
  }
  if (!meta.title && !meta.description && !image) {
    return null;
  }
  return { url, title: meta.title, description: meta.description, siteName: meta.siteName, image };
}

export const tauriBridge: DesktopBridge = {
  init: () => invoke<DesktopInit>("desktop_init"),
  secureGet: (key) => invoke<string | null>("secure_get", { key }),
  secureSet: (key, value) => invoke<void>("secure_set", { key, value }),
  secureDelete: (key) => invoke<void>("secure_delete", { key }),
  checkServer: (url) => invoke<string>("check_server", { url }),
  setServerUrl: (url) => invoke<void>("set_server_url", { url }),
  fetchLinkPreview,
  notify: (id, title, body) => invoke<void>("notify", { id, title, body }),
  setPushToTalk: (shortcut) => invoke<void>("set_push_to_talk", { shortcut }),
  setVoiceState: (inCall, muted, deafened) => invoke<void>("set_voice_state", { inCall, muted, deafened }),
  setCloseToTray: (enabled) => invoke<void>("set_close_to_tray", { enabled }),
  setUnreadBadge: (count) => invoke<void>("set_unread_badge", { count }),
  checkUpdate: () => invoke<DesktopUpdateInfo | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  openUrl: (url) => invoke<void>("plugin:opener|open_url", { url }),
  onEvent: (name, handler) => listen(name, (event) => handler(event.payload as Parameters<typeof handler>[0])),
};
