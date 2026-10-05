// A banner for a live-event notice: shown once (for example, "you were
// removed from this server") and cleared after a short delay or on close.
import { useStore } from "zustand";
import { clearNotice, noticeStore } from "../lib/notice.js";
import { CloseIcon } from "./icons.js";

export function NoticeBanner() {
  const message = useStore(noticeStore, (s) => s.message);
  if (!message) {
    return null;
  }
  return (
    <div
      role="status"
      className="mx-1.5 mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-[#0f2624] py-1.5 pl-3 pr-1.5 text-center text-sm text-accent-text"
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={clearNotice}
        aria-label="Dismiss notice"
        className="icon-btn h-7 w-7 text-accent-text hover:bg-accent-soft hover:text-accent-text"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
