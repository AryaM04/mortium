// Make the link preview of a message that this device sends. The composer
// loads this module with a dynamic import when a message first has a link.
// The web platform asks our own server for the page data (browsers block
// other sites). The preview image is encrypted and uploaded as an
// attachment. See docs/concepts/link-previews.md.
import { createServerLinkPreviewFetcher, type FetchLinkPreview } from "@mortium/client-core";
import type { LinkEmbed } from "@mortium/shared";
import { prepareAttachment } from "./attachment-files.js";
import { currentPlatform } from "./platform.js";
import { session } from "./session.js";

// The desktop app fetches the page itself. The web app asks its server.
const fetchLinkPreview: FetchLinkPreview =
  currentPlatform().fetchLinkPreview ?? createServerLinkPreviewFetcher(session.apiClient);

export interface BuiltLinkPreview {
  embed: LinkEmbed;
  /** A local object URL of the image, for the composer card. Revoke it when the card closes. */
  imageUrl: string | null;
}

/** Make the embed for `url`, or null when the page has no preview. The image goes up encrypted. */
export async function buildLinkPreview(
  channelId: string,
  url: string,
  signal: AbortSignal,
): Promise<BuiltLinkPreview | null> {
  const data = await fetchLinkPreview(url);
  if (!data || signal.aborted) {
    return null;
  }
  const embed: LinkEmbed = {
    type: "link",
    url,
    title: data.title,
    description: data.description,
    siteName: data.siteName,
  };
  let imageUrl: string | null = null;
  if (data.image) {
    const extension = data.image.mime.split("/")[1] ?? "img";
    const file = new File([data.image.bytes as Uint8Array<ArrayBuffer>], `preview.${extension}`, {
      type: data.image.mime,
    });
    try {
      const image = await prepareAttachment(channelId, file, signal, () => {});
      // Only an image that this browser can read gets a thumbnail. Without one, the preview has no image.
      if (image.thumbnail) {
        embed.image = image;
        imageUrl = URL.createObjectURL(file);
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // The upload failed. The preview goes without its image.
    }
  }
  return { embed, imageUrl };
}
