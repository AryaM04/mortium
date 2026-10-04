// The message composer: an autosize textarea, plus the reply/edit banner
// above it and the @-mention suggestion listbox. Enter sends. Shift+Enter
// starts a new line. Escape cancels a reply, an edit, or the mention
// listbox. ArrowUp in an empty box edits the sender's last message. Files come from
// the attach button, a drop or a paste. Each file is encrypted and uploaded
// at once, and the message sends when every upload is done. The first link
// gets a preview card, made on this device (see lib/link-preview.ts). The
// message takes the preview only when it is ready at send time.
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { MAX_ATTACHMENTS, type Attachment, type GuildMemberJson, type LinkEmbed, type User } from "@mortium/shared";
import { findFirstLink, formatFileSize, linkPreviewsOf, searchGuildMembers } from "@mortium/client-core";
import { messagesStore } from "../lib/messages.js";
import { session } from "../lib/session.js";
import { useSettings } from "../lib/settings.js";
import { Avatar } from "./Avatar.js";
import { EmojiPickerButton } from "./EmojiPickerButton.js";

const MAX_BODY_LENGTH = 4000;
const COUNTER_THRESHOLD = MAX_BODY_LENGTH - 200;
const MENTION_RE = /<@(\d+)>/g;
const MAX_MENTIONS = 50;
const MENTION_SEARCH_DEBOUNCE_MS = 150;
const MENTION_SEARCH_LIMIT = 10;
/** The default server limit. The server gives the real error when its limit is lower. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Wait this long after the last change of the link before the preview starts. */
const PREVIEW_DEBOUNCE_MS = 600;

const LinkEmbedCard = lazy(() => import("./LinkEmbedCard.js"));

interface LinkPreviewState {
  url: string;
  /** The preview image is an attachment of this channel. */
  channelId: string;
  controller: AbortController;
  embed?: LinkEmbed;
  imageUrl?: string | null;
}

interface Upload {
  key: number;
  name: string;
  size: number;
  progress: number;
  controller: AbortController;
  result?: Attachment;
  error?: string;
}

let uploadCounter = 0;

/** Extract every `<@id>` token from a message body, in order, with no duplicate and at most 50. */
export function extractMentions(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_MENTIONS) break;
  }
  return ids;
}

export interface MentionQuery {
  /** The index of the "@" that starts the query, inside the full text. */
  start: number;
  /** The name text typed after the "@", up to the caret. */
  query: string;
}

/**
 * Find an open `@` mention query ending at the caret, or null when there
 * is none. A query starts at the beginning of the text or after
 * whitespace, and its text has no whitespace and no second "@".
 */
export function detectMentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) {
    return null;
  }
  const upToCaret = text.slice(0, caret);
  const atIndex = upToCaret.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }
  const before = atIndex === 0 ? "" : upToCaret[atIndex - 1]!;
  if (before !== "" && !/\s/.test(before)) {
    return null;
  }
  const query = upToCaret.slice(atIndex + 1);
  if (query.length > 32 || /\s/.test(query) || query.includes("@")) {
    return null;
  }
  return { start: atIndex, query };
}

export interface ReplyTarget {
  id: string;
  authorName: string;
  preview: string;
}

export interface EditTarget {
  id: string;
  body: string;
}

export interface ComposerProps {
  channelId: string;
  /** Null for a DM. A DM finds mention names in `dmRecipients`, not on the server. */
  guildId: string | null;
  dmRecipients?: User[];
  canSend: boolean;
  disabledReason?: string;
  replyTarget: ReplyTarget | null;
  onCancelReply: () => void;
  editTarget: EditTarget | null;
  onCancelEdit: () => void;
  onRequestEditLast: () => void;
}

/** Find DM recipients whose name starts with the query, in the shape of a member search result. */
function searchDmRecipients(recipients: User[], query: string): GuildMemberJson[] {
  const lower = query.toLowerCase();
  return recipients
    .filter((user) => user.username.startsWith(lower) || user.displayName.toLowerCase().startsWith(lower))
    .slice(0, MENTION_SEARCH_LIMIT)
    .map((user) => ({ guildId: "", userId: user.id, nickname: null, joinedAt: user.createdAt, roles: [], user }));
}

function memberLabel(member: GuildMemberJson): string {
  return member.nickname ?? member.user?.displayName ?? member.userId;
}

export function Composer(props: ComposerProps) {
  const { channelId, guildId, dmRecipients, editTarget } = props;
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();

  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [suggestions, setSuggestions] = useState<GuildMemberJson[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGenerationRef = useRef(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkPreviewsOn = useSettings((s) => linkPreviewsOf(s.values));
  const [preview, setPreview] = useState<LinkPreviewState | null>(null);
  /** Links that get no preview: the user removed the card, or the page had none. */
  const skippedLinksRef = useRef(new Set<string>());
  const link = props.canSend && !editTarget && linkPreviewsOn ? findFirstLink(text) : null;

  function clearPreview(): void {
    setPreview((current) => {
      if (current) {
        current.controller.abort();
        if (current.imageUrl) URL.revokeObjectURL(current.imageUrl);
      }
      return null;
    });
  }

  // Make the preview of the first link, after a short pause in typing.
  useEffect(() => {
    if (preview && preview.url === link && preview.channelId === channelId) {
      return;
    }
    clearPreview();
    if (!link || skippedLinksRef.current.has(link)) {
      return;
    }
    const url = link;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreview({ url, channelId, controller });
      void import("../lib/link-preview.js")
        .then((module) => module.buildLinkPreview(channelId, url, controller.signal))
        .then((built) => {
          if (controller.signal.aborted) {
            if (built?.imageUrl) URL.revokeObjectURL(built.imageUrl);
            return;
          }
          if (!built) {
            skippedLinksRef.current.add(url);
            setPreview(null);
            return;
          }
          setPreview({ url, channelId, controller, embed: built.embed, imageUrl: built.imageUrl });
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setPreview(null);
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The preview depends only on the link and the channel.
  }, [link, channelId]);

  function removePreview(): void {
    if (preview) {
      skippedLinksRef.current.add(preview.url);
    }
    clearPreview();
  }

  useEffect(() => {
    if (editTarget) {
      setText(editTarget.body);
      textareaRef.current?.focus();
    }
  }, [editTarget]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Close the mention listbox and cancel any pending search when the
  // channel changes, so a stale query from another channel never shows.
  // Clear the text too: a draft or an edit belongs to one channel (UI-03).
  useEffect(() => {
    setText("");
    closeMentionMenu();
    // Files belong to one channel. Cancel the uploads when the channel changes.
    setUploads((current) => {
      current.forEach((upload) => upload.controller.abort());
      return [];
    });
  }, [channelId]);

  function updateUpload(key: number, patch: Partial<Upload>): void {
    setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)));
  }

  function addFiles(files: File[]): void {
    if (!props.canSend || editTarget || files.length === 0) {
      return;
    }
    const room = MAX_ATTACHMENTS - uploads.length;
    const added: Upload[] = files.slice(0, Math.max(0, room)).map((file) => ({
      key: ++uploadCounter,
      name: file.name,
      size: file.size,
      progress: 0,
      controller: new AbortController(),
      error: file.size > MAX_FILE_BYTES ? `The file is larger than ${formatFileSize(MAX_FILE_BYTES)}.` : undefined,
    }));
    setUploads((current) => [...current, ...added]);
    added.forEach((upload, index) => {
      if (upload.error) {
        return;
      }
      void import("../lib/attachment-files.js")
        .then((module) =>
          module.prepareAttachment(channelId, files[index]!, upload.controller.signal, (progress) =>
            updateUpload(upload.key, { progress }),
          ),
        )
        .then((result) => updateUpload(upload.key, { result, progress: 1 }))
        .catch((error: unknown) => {
          if (!upload.controller.signal.aborted) {
            updateUpload(upload.key, { error: error instanceof Error ? error.message : "The file could not be uploaded." });
          }
        });
    });
  }

  function removeUpload(key: number): void {
    setUploads((current) =>
      current.filter((upload) => {
        if (upload.key === key) {
          upload.controller.abort();
        }
        return upload.key !== key;
      }),
    );
  }

  function closeMentionMenu(): void {
    setMentionQuery(null);
    setSuggestions([]);
    setActiveIndex(0);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  function scheduleMentionSearch(query: string): void {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (query.length === 0) {
      setSuggestions([]);
      return;
    }
    const generation = ++searchGenerationRef.current;
    if (guildId === null) {
      setSuggestions(searchDmRecipients(dmRecipients ?? [], query));
      setActiveIndex(0);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void searchGuildMembers(session.apiClient, guildId, query, MENTION_SEARCH_LIMIT)
        .then((result) => {
          if (searchGenerationRef.current === generation) {
            setSuggestions(result.members);
            setActiveIndex(0);
          }
        })
        .catch(() => {
          if (searchGenerationRef.current === generation) {
            setSuggestions([]);
          }
        });
    }, MENTION_SEARCH_DEBOUNCE_MS);
  }

  /** Recompute the mention query from the textarea's current text and caret. */
  function syncMentionQuery(el: HTMLTextAreaElement, value: string): void {
    const caret = el.selectionStart ?? value.length;
    const query = detectMentionQueryAt(value, caret);
    setMentionQuery(query);
    if (query) {
      scheduleMentionSearch(query.query);
    } else {
      closeMentionMenu();
    }
  }

  function pickMention(member: GuildMemberJson): void {
    if (!mentionQuery) return;
    const before = text.slice(0, mentionQuery.start);
    const afterQueryIndex = mentionQuery.start + 1 + mentionQuery.query.length;
    const after = text.slice(afterQueryIndex);
    const inserted = `<@${member.userId}> `;
    const nextText = `${before}${inserted}${after}`;
    setText(nextText);
    closeMentionMenu();
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  /** Insert `emoji` at the caret (or at the end of any selection), and put the caret after it. */
  function insertEmoji(emoji: string): void {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const nextText = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    setText(nextText);
    const caret = start + emoji.length;
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  const uploading = uploads.some((upload) => !upload.result && !upload.error);
  const ready = uploads.flatMap((upload) => (upload.result ? [upload.result] : []));

  function submit(): void {
    const body = text.trim();
    if ((body.length === 0 && ready.length === 0) || body.length > MAX_BODY_LENGTH || uploading) {
      return;
    }
    const mentions = extractMentions(body);
    if (editTarget) {
      void messagesStore.getState().editMessage(channelId, editTarget.id, body, mentions);
      props.onCancelEdit();
    } else {
      const embeds = preview?.embed && findFirstLink(body) === preview.url ? [preview.embed] : [];
      void messagesStore.getState().sendMessage(channelId, body, mentions, props.replyTarget?.id, ready, embeds);
      props.onCancelReply();
      setUploads([]);
      clearPreview();
      skippedLinksRef.current.clear();
    }
    setText("");
    closeMentionMenu();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionQuery && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pickMention(suggestions[activeIndex]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      if (props.editTarget) {
        props.onCancelEdit();
        setText("");
      } else if (props.replyTarget) {
        props.onCancelReply();
      }
      return;
    }
    if (event.key === "ArrowUp" && text.length === 0 && !props.editTarget) {
      props.onRequestEditLast();
    }
  }

  const remaining = MAX_BODY_LENGTH - text.length;
  const mentionOpen = mentionQuery !== null && suggestions.length > 0;
  const activeOptionId = mentionOpen ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div className="px-4 pb-4">
      {(props.replyTarget || props.editTarget) && (
        <div
          className="mb-1 flex items-center justify-between rounded-t px-3 py-1 text-xs"
          style={{ backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-muted)" }}
        >
          <span>
            {props.editTarget ? "Editing a message." : `Reply to ${props.replyTarget!.authorName}.`}
          </span>
          <button
            type="button"
            onClick={() => {
              if (props.editTarget) {
                props.onCancelEdit();
                setText("");
              } else {
                props.onCancelReply();
              }
            }}
            aria-label="Cancel"
          >
            ×
          </button>
        </div>
      )}
      {mentionOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Members"
          className="mb-1 max-h-56 overflow-y-auto rounded border py-1 shadow-lg"
          style={{ backgroundColor: "var(--color-bg-main)", borderColor: "var(--color-border)" }}
        >
          {suggestions.map((member, index) => (
            <div
              key={member.userId}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                pickMention(member);
              }}
              className="flex items-center gap-2 px-3 py-1 text-sm"
              style={{ backgroundColor: index === activeIndex ? "var(--color-bg-sidebar)" : "transparent" }}
            >
              {member.user && <Avatar user={member.user} size={20} />}
              <span>{memberLabel(member)}</span>
              {member.user && (
                <span style={{ color: "var(--color-text-muted)" }}>@{member.user.username}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div className="mb-1" data-link-preview-state={preview.embed ? "ready" : "loading"}>
          {preview.embed ? (
            <Suspense fallback={null}>
              <LinkEmbedCard embed={preview.embed} localImageUrl={preview.imageUrl} onRemove={removePreview} />
            </Suspense>
          ) : (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <span>Loading the link preview.</span>
              <button type="button" onClick={removePreview} className="underline">
                Remove preview
              </button>
            </div>
          )}
        </div>
      )}
      {uploads.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-2" aria-label="Files to send">
          {uploads.map((upload) => (
            <li
              key={upload.key}
              className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
              style={{ borderColor: upload.error ? "var(--color-danger-text)" : "var(--color-border)" }}
              data-upload-state={upload.error ? "failed" : upload.result ? "ready" : "uploading"}
            >
              <span className="max-w-40 truncate">{upload.name}</span>
              <span style={{ color: upload.error ? "var(--color-danger-text)" : "var(--color-text-muted)" }}>
                {upload.error ?? (upload.result ? formatFileSize(upload.size) : `${Math.round(upload.progress * 100)}%`)}
              </span>
              <button type="button" onClick={() => removeUpload(upload.key)} aria-label={`Remove ${upload.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="flex items-end gap-2 rounded px-3 py-2"
        style={{ backgroundColor: "var(--color-bg-sidebar)" }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length > 0) {
            event.preventDefault();
            addFiles([...event.dataTransfer.files]);
          }
        }}
      >
        {props.canSend && !editTarget && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              aria-label="Files to attach"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploads.length >= MAX_ATTACHMENTS}
              className="rounded px-1.5 py-1 text-base"
              style={{ color: "var(--color-text-muted)" }}
            >
              +
            </button>
          </>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={!props.canSend}
          placeholder={props.canSend ? "Write a message." : props.disabledReason ?? "You cannot send a message here."}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={mentionOpen}
          aria-controls={mentionOpen ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            if (value.length > 0) {
              messagesStore.getState().notifyTyping(channelId);
            }
            syncMentionQuery(event.target, value);
          }}
          onSelect={(event) => syncMentionQuery(event.currentTarget, event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              addFiles([...event.clipboardData.files]);
            }
          }}
          className="max-h-60 flex-1 resize-none bg-transparent py-1 text-sm outline-none"
          style={{ color: "var(--color-text-primary)" }}
        />
        {remaining <= COUNTER_THRESHOLD && (
          <span
            className="pb-1 text-xs"
            style={{ color: remaining < 0 ? "var(--color-danger-text)" : "var(--color-text-muted)" }}
          >
            {remaining}
          </span>
        )}
        {props.canSend && (
          <EmojiPickerButton
            ariaLabel="Open the emoji picker"
            label="🙂"
            onPick={insertEmoji}
            className="rounded px-1.5 py-1 text-base"
            style={{ color: "var(--color-text-muted)" }}
          />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={
            !props.canSend ||
            uploading ||
            (text.trim().length === 0 && ready.length === 0) ||
            text.length > MAX_BODY_LENGTH
          }
          className="rounded px-3 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-accent)", color: "white" }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
