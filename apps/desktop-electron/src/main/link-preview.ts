// Link previews of the Linux app. The main process fetches the page and
// its image with the same code and the same address rules as the server
// (packages/link-preview-fetch), so a link cannot reach the private
// network of the user. The fetch never logs the URL.
import { createLinkPreviewFetcher, LinkPreviewError, type LinkPreviewFetcher } from "@mortium/link-preview-fetch";
import type { DesktopLinkPreview } from "@mortium/shared";

export function createLinkPreview(fetcher: LinkPreviewFetcher = createLinkPreviewFetcher()) {
  /** The preview of a link, or null when the page has no preview or the link is not allowed. */
  return async function fetchLinkPreview(url: string): Promise<DesktopLinkPreview | null> {
    try {
      const preview = await fetcher(url);
      return {
        url,
        title: preview.title,
        description: preview.description,
        siteName: preview.siteName,
        // A plain Uint8Array crosses IPC as bytes. A Buffer would too, but this makes the copy clear.
        image: preview.image ? { bytes: new Uint8Array(preview.image.bytes), mime: preview.image.mime } : undefined,
      };
    } catch (error) {
      if (error instanceof LinkPreviewError) {
        return null;
      }
      throw error;
    }
  };
}
