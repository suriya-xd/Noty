import { useLayoutEffect, useRef, useState } from "react";
import type { FC, FormEvent } from "react";
import { ExternalLink, Link2, Pencil, Unlink } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { applyLink, normalizeUrl, removeLink } from "./editorCommands";
import type { FoundLink, LinkRequest } from "./editorCommands";
import { openExternal } from "../services/noeticBridge";
import { useBackLayer } from "../utils/backNavigation";

/**
 * What the popup is showing:
 *  - "edit": add a link, or change one (address, and whether the address itself or other text
 *    is shown in the note);
 *  - "actions": a tapped link on a phone, with Open / Edit / Remove. (On a computer a click
 *    opens the link straight away.)
 */
export type LinkPopoverState =
  | { mode: "edit"; request: LinkRequest }
  | { mode: "actions"; link: FoundLink };

interface LinkPopoverProps {
  view: EditorView | null;
  state: LinkPopoverState | null;
  onChange: (next: LinkPopoverState | null) => void;
}

const GAP = 8;
const MARGIN = 12;

/** Places the popup just below the link (or cursor), or above it when there's no room below. */
function usePlacement(view: EditorView | null, pos: number | null, open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number; visibility: "hidden" | "visible" }>({
    top: 0,
    left: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open || !view || pos === null) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const vv = window.visualViewport;
      const vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
      const vw = window.innerWidth;
      const coords = view.coordsAtPos(pos) ?? view.coordsAtPos(Math.min(pos, view.state.doc.length));
      const rect = el.getBoundingClientRect();
      const anchorTop = coords?.top ?? vh / 3;
      const anchorBottom = coords?.bottom ?? vh / 3;
      const anchorLeft = coords?.left ?? vw / 2;
      let top = anchorBottom + GAP;
      if (top + rect.height > vh - MARGIN) top = Math.max(MARGIN + (vv?.offsetTop ?? 0), anchorTop - GAP - rect.height);
      const left = Math.min(Math.max(MARGIN, anchorLeft - 16), vw - rect.width - MARGIN);
      setStyle({ top, left: Math.max(MARGIN, left), visibility: "visible" });
    };
    place();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", place);
    window.addEventListener("resize", place);
    return () => {
      vv?.removeEventListener("resize", place);
      window.removeEventListener("resize", place);
    };
  }, [view, pos, open]);

  return { ref, style };
}

export const LinkPopover: FC<LinkPopoverProps> = ({ view, state, onChange }) => {
  const open = !!state && !!view;
  const pos = state ? (state.mode === "edit" ? state.request.from : state.link.from) : null;
  const { ref, style } = usePlacement(view, pos, open);

  const close = (refocus = true) => {
    onChange(null);
    if (refocus) view?.focus();
  };
  useBackLayer(open, () => close());

  if (!open || !view || !state) return null;

  return (
    <>
      {/* Clicking outside closes it, without the click landing in the note. */}
      <div className="fixed inset-0 z-[65]" onMouseDown={(e) => (e.preventDefault(), close())} />
      <div
        ref={ref}
        role="dialog"
        aria-label={state.mode === "edit" ? (state.request.editing ? "Edit link" : "Add link") : "Link"}
        style={{ top: style.top, left: style.left, visibility: style.visibility }}
        className="fixed z-[66] w-[min(340px,calc(100vw-24px))] rounded-xl border border-[#30363d] bg-[#161b22] shadow-2xl shadow-black/50 text-zinc-100 m-toast-in"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        {state.mode === "edit" ? (
          <LinkForm
            key={`${state.request.from}:${state.request.to}`}
            request={state.request}
            onSubmit={(url, text) => {
              applyLink(view, state.request, url, text);
              close();
            }}
            onCancel={() => close()}
          />
        ) : (
          <LinkActions
            link={state.link}
            onOpen={() => {
              void openExternal(state.link.url);
              close(false);
            }}
            onEdit={() => onChange({ mode: "edit", request: { ...state.link, editing: true } })}
            onRemove={() => {
              removeLink(view, state.link);
              close();
            }}
          />
        )}
      </div>
    </>
  );
};

const LinkForm: FC<{
  request: LinkRequest;
  onSubmit: (url: string, text: string | null) => void;
  onCancel: () => void;
}> = ({ request, onSubmit, onCancel }) => {
  const [url, setUrl] = useState(request.url);
  const [showText, setShowText] = useState(!!request.text && request.text !== request.url);
  const [text, setText] = useState(request.text);
  const textRef = useRef<HTMLInputElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeUrl(url);
    if (!clean) return;
    onSubmit(clean, showText && text.trim() ? text.trim() : null);
  };

  const choose = (custom: boolean) => {
    setShowText(custom);
    if (custom) requestAnimationFrame(() => textRef.current?.focus());
  };

  const segment = (active: boolean) =>
    `flex-1 h-8 rounded-md text-xs font-medium transition-colors cursor-pointer ${
      active ? "bg-[#30363d] text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200"
    }`;

  return (
    <form onSubmit={submit} className="p-3 space-y-2.5">
      <label className="flex items-center gap-2 h-10 px-3 rounded-lg bg-[#0d1117] border border-[#30363d] focus-within:border-sky-500/70">
        <Link2 className="w-4 h-4 text-zinc-500 shrink-0" />
        <input
          autoFocus
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Paste or type a link"
          aria-label="Link address"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
        />
      </label>

      <div role="radiogroup" aria-label="Show in the note" className="flex p-0.5 rounded-lg bg-[#0d1117] border border-[#30363d]">
        <button type="button" role="radio" aria-checked={!showText} onClick={() => choose(false)} className={segment(!showText)}>
          Show link
        </button>
        <button type="button" role="radio" aria-checked={showText} onClick={() => choose(true)} className={segment(showText)}>
          Show text instead
        </button>
      </div>

      {showText && (
        <input
          ref={textRef}
          type="text"
          autoCapitalize="sentences"
          placeholder="Text to show"
          aria-label="Text to show"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-10 px-3 rounded-lg bg-[#0d1117] border border-[#30363d] focus:border-sky-500/70 text-sm text-white placeholder:text-zinc-500 outline-none"
        />
      )}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-lg text-xs font-medium text-zinc-300 hover:bg-[#21262d] cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!url.trim()}
          className="h-8 px-4 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40 disabled:hover:bg-sky-600 cursor-pointer disabled:cursor-default"
        >
          {request.editing ? "Save" : "Add link"}
        </button>
      </div>
    </form>
  );
};

const LinkActions: FC<{
  link: FoundLink;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
}> = ({ link, onOpen, onEdit, onRemove }) => {
  const btn =
    "h-9 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium text-zinc-300 hover:bg-[#21262d] active:bg-[#21262d] cursor-pointer";
  return (
    <div className="p-1.5 flex items-center gap-1">
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 h-9 px-2.5 rounded-lg flex items-center gap-2 text-left hover:bg-[#21262d] active:bg-[#21262d] cursor-pointer">
        <ExternalLink className="w-4 h-4 text-sky-400 shrink-0" />
        <span className="truncate text-xs text-sky-300">{link.url.replace(/^(https?:\/\/|mailto:)/i, "")}</span>
      </button>
      <button type="button" aria-label="Edit link" onClick={onEdit} className={btn}>
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button type="button" aria-label="Remove link" onClick={onRemove} className={btn}>
        <Unlink className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
