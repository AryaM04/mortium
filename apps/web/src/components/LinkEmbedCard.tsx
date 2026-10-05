// The card of one link preview: site name, title (a link), description
// and image. The sender made it. This client never fetches the URL. The
// image is an encrypted attachment, or a local object URL in the composer.
import type { LinkEmbed } from "@mortium/shared";
import { useDecryptedUrl } from "./AttachmentList.js";
import { CloseIcon } from "./icons.js";

function EmbedImage({ image }: { image: NonNullable<LinkEmbed["image"]> }) {
  const thumbnail = image.thumbnail!;
  const { url } = useDecryptedUrl(thumbnail.id, thumbnail, "image/webp");
  return url ? (
    <img
      src={url}
      alt=""
      width={thumbnail.width}
      height={thumbnail.height}
      className="mt-2 max-h-40 w-auto rounded-md"
      data-testid="link-embed-image"
    />
  ) : null;
}

export function LinkEmbedCard({
  embed,
  localImageUrl,
  onRemove,
}: {
  embed: LinkEmbed;
  /** The composer shows the image from local bytes, before the message is sent. */
  localImageUrl?: string | null;
  onRemove?: () => void;
}) {
  return (
    <div
      className="mt-1.5 flex max-w-md gap-2 rounded-lg border border-l-[3px] border-line border-l-accent bg-elevated px-3 py-2.5"
      data-testid="link-embed"
    >
      <div className="min-w-0 flex-1">
        {embed.siteName && (
          <div className="truncate text-xs text-muted">
            {embed.siteName}
          </div>
        )}
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="link block truncate text-sm font-semibold"
        >
          {embed.title ?? embed.url}
        </a>
        {embed.description && (
          <p className="mt-0.5 line-clamp-3 text-xs text-secondary">
            {embed.description}
          </p>
        )}
        {localImageUrl ? (
          <img src={localImageUrl} alt="" className="mt-2 max-h-40 w-auto rounded-md" />
        ) : (
          embed.image?.thumbnail && <EmbedImage image={embed.image} />
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="icon-btn h-6 w-6 self-start"
          aria-label="Remove preview"
          title="Remove preview"
        >
          <CloseIcon size={14} />
        </button>
      )}
    </div>
  );
}

export default LinkEmbedCard;
