"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { Message } from "@/lib/errors";
import { GlyphAlert, GlyphClose } from "./glyphs";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside the modal by wrapping from the last control to the first and back. */
function cycleFocus(e: KeyboardEvent<HTMLDialogElement>) {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** Hide the visible title bar (the title still labels the dialog). */
  bare?: boolean;
}

/** Native <dialog>: the browser provides the focus trap, Escape, and returns focus to the opener. */
export function Dialog({ open, onClose, title, children, className, bare }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={cycleFocus}
      className={className}
    >
      {open && (
        <div className={bare ? "" : "flex max-h-[inherit] flex-col"}>
          <div
            className={
              bare ? "sr-only" : "flex items-center justify-between gap-3 border-b border-hair px-4 py-2"
            }
          >
            <h2 id={titleId} className="h-section">
              {title}
            </h2>
            {!bare && (
              <button type="button" className="btn btn-quiet" onClick={onClose}>
                <GlyphClose />
                Tutup
              </button>
            )}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

type Kind = "loading" | "empty" | "error" | "forbidden" | "expired";

interface StateBlockProps {
  kind: Kind;
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** One block for every non-happy state. Text always carries the meaning; the glyph is extra. */
export function StateBlock({ kind, title, hint, action }: StateBlockProps) {
  const isError = kind === "error" || kind === "forbidden" || kind === "expired";
  return (
    <div
      className="border border-hair bg-panel p-4 text-ink"
      role={isError ? "alert" : "status"}
      aria-busy={kind === "loading" ? true : undefined}
      data-state={kind}
    >
      <p className="flex items-start gap-2 font-bold">
        {isError ? <GlyphAlert /> : null}
        <span>{title}</span>
      </p>
      {hint ? <p className="mt-1 text-muted">{hint}</p> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export const fromMessage = (m: Message) => ({ title: m.title, hint: m.hint });
