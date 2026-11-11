import { useEffect, useRef, useState } from "react";
import type { FC } from "react";

/** Calls `onEscape` when Escape is pressed while `active` is true. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        handler.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

const overlay = "fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4";
const panel = "app-dialog w-full max-w-sm rounded-xl bg-[#161b22] border border-[#30363d] shadow-2xl p-5 text-left";
const btn = "h-9 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onClose: () => void;
}

/** In-app replacement for window.confirm(). */
export const ConfirmDialog: FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onClose,
}) => {
  useEscapeKey(open, onClose);
  if (!open) return null;

  return (
    <div className={overlay} role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className={panel} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btn} bg-[#21262d] text-zinc-200 hover:bg-[#30363d]`}>
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className={`${btn} ${
              tone === "danger" ? "bg-red-600 text-white hover:bg-red-500" : "bg-sky-500 text-[#04121d] hover:bg-sky-400"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** In-app replacement for window.prompt(). */
export const PromptDialog: FC<PromptDialogProps> = ({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  confirmLabel,
  onSubmit,
  onClose,
}) => {
  const [value, setValue] = useState(initialValue);
  useEscapeKey(open, onClose);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open) return null;
  const trimmed = value.trim();

  return (
    <div className={overlay} role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <form
        className={panel}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onSubmit(trimmed);
        }}
      >
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <label className="mt-3 block">
          <span className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</span>
          <input
            autoFocus
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="w-full h-9 rounded-lg bg-[#0d1117] border border-[#30363d] focus:border-sky-500 px-3 text-sm text-white outline-none select-text"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btn} bg-[#21262d] text-zinc-200 hover:bg-[#30363d]`}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed}
            className={`${btn} bg-sky-500 text-[#04121d] hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};
