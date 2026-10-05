// One message row: avatar and name (only on the first message of a
// group), the body, a reply preview line, the reactions row and the
// hover actions (react, reply, edit, delete).
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AggregatedMessage } from "@mortium/client-core";
import { Markdown, MarkdownInline } from "./Markdown.js";
import { Avatar } from "./Avatar.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";
import type { User } from "@mortium/shared";
import { PencilIcon, PlusIcon, ReplyArrowIcon, ReplyIcon, SmileIcon, TrashIcon } from "./icons.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉"];

// Most messages have no files, so the file views load only when one is needed.
const AttachmentList = lazy(() =>
  import("./AttachmentList.js").then((module) => ({ default: module.AttachmentList })),
);
const LinkEmbedCard = lazy(() => import("./LinkEmbedCard.js"));

function DeleteConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onCancel} className="w-full max-w-sm p-5">
      <p className="mb-4 text-sm">Do you want to delete this message? You cannot undo this.</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className="btn btn-danger">
          Delete
        </button>
      </div>
    </dialog>
  );
}

export interface MessageItemProps {
  message: AggregatedMessage;
  showHeader: boolean;
  author: User | undefined;
  authorName: string;
  isOwn: boolean;
  canManageMessages: boolean;
  selfUserId: string | null;
  isHighlighted: boolean;
  replyPreview: { authorName: string; text: string } | null;
  getDisplayName: (userId: string) => string | undefined;
  getReactorNames: (userIds: string[]) => string;
  onReplyClick: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleReaction: (key: string) => void;
  onAddReaction: (key: string) => void;
}

export function MessageItem(props: MessageItemProps) {
  const { message } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const time = new Date(message.createdAt);
  const timeLabel = time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fullDate = time.toLocaleString();

  /** Toggle a reaction picked from the full emoji picker, the same way an existing reaction pill toggles. */
  function togglePickedReaction(key: string): void {
    const existing = message.reactions.find((r) => r.key === key);
    if (existing?.ownEventId) {
      props.onToggleReaction(key);
    } else {
      props.onAddReaction(key);
    }
  }

  function handleDeleteClick(event: React.MouseEvent): void {
    if (event.shiftKey) {
      props.onDelete();
    } else {
      setConfirmOpen(true);
    }
  }

  return (
    <div
      className={`group relative mx-2 flex gap-3 rounded-lg px-3 py-0.5 hover:bg-hover focus-within:bg-hover ${props.showHeader ? "mt-3 pt-1" : ""}`}
      style={{ backgroundColor: props.isHighlighted ? "rgba(45, 212, 191, 0.15)" : undefined }}
      data-message-id={message.id}
    >
      <div className="w-9 shrink-0 pt-0.5">
        {props.showHeader && props.author && <Avatar user={props.author} size={36} />}
      </div>
      <div className="min-w-0 flex-1">
        {props.replyPreview && (
          <button
            type="button"
            onClick={props.onReplyClick}
            className="mb-0.5 flex max-w-full items-center gap-1 truncate text-xs text-muted hover:text-secondary"
          >
            <ReplyArrowIcon size={12} className="shrink-0" />
            <span className="font-medium text-secondary">{props.replyPreview.authorName}</span>
            <span className="truncate">{props.replyPreview.text}</span>
          </button>
        )}
        {props.showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-primary">{props.authorName}</span>
            <span className="text-xs text-muted" title={fullDate}>
              {timeLabel}
            </span>
          </div>
        )}
        <div
          className="markdown text-sm leading-relaxed"
          style={{
            color:
              message.deleted || message.cannotRead
                ? "var(--color-text-muted)"
                : "var(--color-text-primary)",
            fontStyle: message.deleted || message.cannotRead ? "italic" : "normal",
          }}
        >
          {message.deleted || message.cannotRead
            ? message.body
            : message.body.length > 0 && (
                <Markdown
                  text={message.body}
                  getDisplayName={props.getDisplayName}
                  selfUserId={props.selfUserId}
                />
              )}
          {message.edited && !message.deleted && (
            <span className="ml-1 text-xs text-muted">(edited)</span>
          )}
        </div>

        {!message.deleted && !message.cannotRead && message.attachments.length > 0 && (
          <Suspense fallback={null}>
            <AttachmentList attachments={message.attachments} />
          </Suspense>
        )}

        {!message.deleted && !message.cannotRead && message.embeds.length > 0 && (
          <Suspense fallback={null}>
            {message.embeds.map((embed) => (
              <LinkEmbedCard key={embed.url} embed={embed} />
            ))}
          </Suspense>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.key}
                type="button"
                title={props.getReactorNames(reaction.userIds)}
                onClick={() => props.onToggleReaction(reaction.key)}
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                  reaction.ownEventId
                    ? "border-accent bg-accent-soft text-accent-text"
                    : "border-line-strong bg-elevated text-secondary hover:border-muted"
                }`}
              >
                {reaction.key} {reaction.userIds.length}
              </button>
            ))}
          </div>
        )}
      </div>

      {!message.deleted && !message.cannotRead && (
        <div className="menu absolute -top-3 right-3 z-10 hidden items-center gap-0.5 rounded-lg p-0.5 shadow-[var(--shadow-soft)] group-hover:flex group-focus-within:flex">
          <div className="relative">
            <button
              type="button"
              aria-label="React"
              title="React"
              onClick={() => setPickerOpen((o) => !o)}
              className="icon-btn h-7 w-7"
            >
              <SmileIcon />
            </button>
            {pickerOpen && (
              <div className="menu absolute right-0 top-full z-10 mt-1 flex gap-0.5 p-1">
                {QUICK_REACTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      props.onAddReaction(key);
                      setPickerOpen(false);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-hover"
                  >
                    {key}
                  </button>
                ))}
                <EmojiPickerButton
                  ariaLabel="More emoji"
                  label={<PlusIcon />}
                  onPick={(emoji) => {
                    togglePickedReaction(emoji);
                    setPickerOpen(false);
                  }}
                  className="icon-btn"
                />
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Reply"
            title="Reply"
            onClick={props.onReply}
            className="icon-btn h-7 w-7"
          >
            <ReplyIcon />
          </button>
          {props.isOwn && (
            <button
              type="button"
              aria-label="Edit"
              title="Edit"
              onClick={props.onEdit}
              className="icon-btn h-7 w-7"
            >
              <PencilIcon />
            </button>
          )}
          {(props.isOwn || props.canManageMessages) && (
            <button
              type="button"
              aria-label="Delete"
              title="Delete"
              onClick={handleDeleteClick}
              className="icon-btn h-7 w-7 hover:text-danger-text"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      )}

      <DeleteConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          props.onDelete();
        }}
      />
    </div>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="mx-5 mb-1 mt-5 flex items-center gap-3 text-xs font-medium text-muted">
      <div className="h-px flex-1 bg-line" />
      {label}
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

export function NewDivider() {
  return (
    <div className="mx-5 my-1 flex items-center gap-2 text-xs font-semibold text-danger-text">
      <div className="h-px flex-1 bg-danger-text/50" />
      <span className="rounded bg-danger-soft px-1.5 py-0.5 leading-none">New</span>
    </div>
  );
}

/** A pending (optimistic) or failed send, shown dimmed with retry/discard actions. */
export function PendingMessageRow({
  body,
  failed,
  error,
  onRetry,
  onDiscard,
}: {
  body: string;
  failed: boolean;
  /** The server error text of the failed send, when there is one. */
  error?: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mx-2 flex gap-3 px-3 py-0.5" style={{ opacity: 0.6 }}>
      <div className="w-9 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <MarkdownInline text={body} />
        {failed && (
          <span className="ml-2 text-xs text-danger-text" role="alert">
            Not sent.{error ? ` ${error}` : ""}{" "}
            <button type="button" onClick={onRetry} className="link">
              Try again
            </button>{" "}
            /{" "}
            <button type="button" onClick={onDiscard} className="link">
              Delete
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
