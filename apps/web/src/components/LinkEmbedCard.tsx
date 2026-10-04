// The card of one link preview: site name, title (a link), description
// and image. The sender made it. This client never fetches the URL. The
// image is an encrypted attachment, or a local object URL in the composer.
import type { LinkEmbed } from "@mortium/shared";
import { useDecryptedUrl } from "./AttachmentList.js";

function EmbedImage({ image }: { image: NonNullable<LinkEmbed["image"]> }) {
  const thumbnail = image.thumbnail!;
  const { url } = useDecryptedUrl(thumbnail.id, thumbnail, "image/webp");
  return url ? (
    <img
      src={url}
      alt=""
      width={thumbnail.width}
      height={thumbnail.height}
      className="mt-2 max-h-40 w-auto rounded"
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
      className="mt-1 flex max-w-md gap-2 rounded border-l-4 px-3 py-2"
      style={{ borderColor: "var(--color-accent)", backgroundColor: "var(--color-bg-sidebar)" }}
      data-testid="link-embed"
    >
      <div className="min-w-0 flex-1">
        {embed.siteName && (
          <div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
            {embed.siteName}
          </div>
        )}
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="block truncate text-sm font-semibold underline"
          style={{ color: "var(--color-accent-text)" }}
        >
          {embed.title ?? embed.url}
        </a>
        {embed.description && (
          <p className="line-clamp-3 text-xs" style={{ color: "var(--color-text-primary)" }}>
            {embed.description}
          </p>
        )}
        {localImageUrl ? (
          <img src={localImageUrl} alt="" className="mt-2 max-h-40 w-auto rounded" />
        ) : (
          embed.image?.thumbnail && <EmbedImage image={embed.image} />
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="self-start text-sm"
          aria-label="Remove preview"
          title="Remove preview"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default LinkEmbedCard;
