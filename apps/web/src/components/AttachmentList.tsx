// The encrypted files of one message. An image shows its decrypted
// thumbnail, and a click opens the full image in a lightbox. Every other
// file shows a card with a download button. Nothing runs inline: only PNG,
// JPEG, GIF and WebP show as images, and a download uses the `download`
// attribute.
import { useEffect, useRef, useState } from "react";
import { formatFileSize, isInlineImage, type FileSecrets } from "@mortium/client-core";
import type { Attachment } from "@mortium/shared";
import { DownloadIcon, FileIcon } from "./icons.js";

const loadFiles = () => import("../lib/attachment-files.js");

/** Download and decrypt one file. The secrets never change for one id. */
export function useDecryptedUrl(id: string, secrets: FileSecrets, mime: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    loadFiles()
      .then((files) => files.loadDecrypted(id, secrets, mime))
      .then((next) => active && setUrl(next))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [id, mime]);
  return { url, failed };
}

function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { url, failed } = useDecryptedUrl(attachment.id, attachment, attachment.mime);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={attachment.name}
      className="max-h-[90vh] max-w-[90vw] p-2"
    >
      {url ? (
        <img src={url} alt={attachment.name} data-testid="lightbox-image" className="max-h-[80vh] max-w-[85vw] object-contain" />
      ) : (
        <p className="p-4 text-sm">{failed ? "The image cannot be shown." : "Loading the image."}</p>
      )}
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={onClose} className="btn btn-secondary px-3 py-1">
          Close
        </button>
      </div>
    </dialog>
  );
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const thumbnail = attachment.thumbnail!;
  const { url, failed } = useDecryptedUrl(thumbnail.id, thumbnail, "image/webp");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open the image ${attachment.name}`}
        className="block overflow-hidden rounded-lg border border-line bg-elevated"
        style={{ width: thumbnail.width, height: thumbnail.height }}
      >
        {url && <img src={url} alt={attachment.name} width={thumbnail.width} height={thumbnail.height} data-testid="attachment-thumbnail" />}
        {failed && <span className="p-2 text-xs">The image cannot be shown.</span>}
      </button>
      {open && <Lightbox attachment={attachment} onClose={() => setOpen(false)} />}
    </>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function download(): Promise<void> {
    setState("busy");
    try {
      await (await loadFiles()).saveAttachment(attachment);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <div
      className="card flex max-w-sm items-center gap-3 rounded-lg px-3 py-2"
      data-testid="attachment-file"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
        <FileIcon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{attachment.name}</div>
        <div className={`text-xs ${state === "failed" ? "text-danger-text" : "text-muted"}`}>
          {state === "failed" ? "The file could not be downloaded." : formatFileSize(attachment.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void download()}
        disabled={state === "busy"}
        aria-label={`Download ${attachment.name}`}
        className="icon-btn"
      >
        <DownloadIcon />
      </button>
    </div>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 flex flex-col gap-1">
      {attachments.map((attachment) =>
        isInlineImage(attachment.mime) && attachment.thumbnail ? (
          <ImageAttachment key={attachment.id} attachment={attachment} />
        ) : (
          <FileAttachment key={attachment.id} attachment={attachment} />
        ),
      )}
    </div>
  );
}
