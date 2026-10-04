// Link previews on the sender side: find the first link of a message, and
// ask the platform for its preview before the message is encrypted. The
// web platform asks our own server (browsers block other sites). A
// desktop platform fetches the page itself. A receiver never fetches
// the URL. See docs/concepts/link-previews.md.
import {
  decodeBase64Url,
  linkPreviewResponseSchema,
  MAX_EMBED_URL_LENGTH,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";

/** A preview that the platform made, before its image is encrypted and uploaded. */
export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: { bytes: Uint8Array; mime: string };
}

/** The platform function that makes a preview. It gives null when the page has no preview. */
export type FetchLinkPreview = (url: string) => Promise<LinkPreviewData | null>;

/** The web client waits this long for its server. The server itself stops the fetch after 3 s. */
export const LINK_PREVIEW_CLIENT_TIMEOUT_MS = 4000;

const LINK_PATTERN = /https?:\/\/[^\s<>]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;

/** Remove punctuation after a link, and a closing bracket that has no open bracket in the link. */
function trimLink(link: string): string {
  let result = link.replace(TRAILING_PUNCTUATION, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (result.endsWith(close) && result.split(open).length < result.split(close).length) {
      result = result.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
  }
  return result;
}

/**
 * The first http or https link of a message body, or null. A link in angle
 * brackets (`<https://example.com>`) gets no preview, as in Discord.
 */
export function findFirstLink(body: string): string | null {
  for (const match of body.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    if (body[start - 1] === "<") {
      continue;
    }
    const link = trimLink(match[0]);
    if (link.length > MAX_EMBED_URL_LENGTH) {
      continue;
    }
    try {
      const url = new URL(link);
      if (url.hostname.length > 0) {
        return link;
      }
    } catch {
      // Not a URL. Try the next one.
    }
  }
  return null;
}

/** The web platform's preview function: it asks our own server, through `POST /link-preview`. */
export function createServerLinkPreviewFetcher(api: ApiClient): FetchLinkPreview {
  return async (url) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LINK_PREVIEW_CLIENT_TIMEOUT_MS);
    });
    const request = api
      .request("POST", "/link-preview", { body: { url }, schema: linkPreviewResponseSchema })
      .then((response): LinkPreviewData => ({
        url,
        title: response.title,
        description: response.description,
        siteName: response.siteName,
        image: response.image
          ? { mime: response.image.mime, bytes: decodeBase64Url(response.image.data) }
          : undefined,
      }))
      .catch(() => null);
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
