import { useEffect, useState } from "react";
import type { FC, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Shared touch primitives for the mobile shell: a bottom sheet, action rows,
 * and sheet-based replacements for the native prompt()/confirm() dialogs.
 */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

export const Sheet: FC<SheetProps> = ({ open, onClose, title, subtitle, children }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 m-fade-in cursor-default"
      />
      <div className="relative m-sheet-up bg-[#161b22] border-t border-[#30363d] rounded-t-3xl shadow-2xl max-h-[85dvh] flex flex-col w-full max-w-xl mx-auto">
        <div className="pt-2.5 pb-1 flex justify-center shrink-0">
          <span className="w-9 h-1 rounded-full bg-[#30363d]" />
        </div>
        {title && (
          <div className="px-5 pt-1 pb-3 shrink-0">
            <h2 className="font-headline text-[17px] font-semibold text-[#f0f6fc] truncate">{title}</h2>
            {subtitle && <p className="text-[13px] text-[#8b949e] mt-0.5 truncate">{subtitle}</p>}
          </div>
        )}
        <div className="overflow-y-auto px-3 pb-3">{children}</div>
        <div className="pb-safe shrink-0" />
      </div>
    </div>
  );
};

interface SheetActionProps {
  icon: LucideIcon;
  label: string;
  hint?: string;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  selected?: boolean;
  onClick: () => void;
}

export const SheetAction: FC<SheetActionProps> = ({
  icon: Icon,
  label,
  hint,
  tone = "default",
  disabled,
  selected,
  onClick,
}) => {
  const color =
    tone === "danger" ? "text-red-400" : tone === "accent" || selected ? "text-sky-400" : "text-[#e6edf3]";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full min-h-[52px] px-3 rounded-xl flex items-center gap-3.5 text-left transition-colors active:bg-[#21262d] disabled:opacity-35 disabled:active:bg-transparent ${
        selected ? "bg-sky-500/10" : ""
      }`}
    >
      <Icon className={`w-5 h-5 shrink-0 ${tone === "default" && !selected ? "text-[#8b949e]" : color}`} />
      <span className="flex-1 min-w-0">
        <span className={`block text-[15px] font-medium truncate ${color}`}>{label}</span>
        {hint && <span className="block text-[13px] text-[#8b949e] truncate">{hint}</span>}
      </span>
    </button>
  );
};

interface TextPromptSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  /** Shown after the input, e.g. ".md" */
  suffix?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export const TextPromptSheet: FC<TextPromptSheetProps> = ({
  open,
  title,
  subtitle,
  initialValue = "",
  placeholder,
  confirmLabel,
  suffix,
  onSubmit,
  onClose,
}) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const invalid = /[\\/:*?"<>|]/.test(trimmed);
  const canSubmit = trimmed.length > 0 && !invalid;

  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle}>
      <form
        className="px-2 pt-1 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(trimmed);
        }}
      >
        <div
          className={`flex items-center h-12 rounded-xl bg-[#0d1117] border px-3.5 ${
            invalid ? "border-red-500/70" : "border-[#30363d] focus-within:border-sky-500"
          }`}
        >
          <input
            autoFocus
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            enterKeyHint="done"
            autoCapitalize="sentences"
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent text-[#f0f6fc] placeholder:text-[#6e7681] outline-none select-text"
          />
          {suffix && <span className="text-[14px] text-[#6e7681] font-mono pl-2 shrink-0">{suffix}</span>}
        </div>
        {invalid && (
          <p className="text-[13px] text-red-400 px-1">{'Names can\'t contain \\ / : * ? " < > |'}</p>
        )}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-12 rounded-xl bg-[#21262d] text-[#e6edf3] text-[15px] font-medium active:bg-[#30363d]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex-1 h-12 rounded-xl bg-sky-500 text-[#04121d] text-[15px] font-semibold active:bg-sky-400 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Sheet>
  );
};

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmSheet: FC<ConfirmSheetProps> = ({ open, title, message, confirmLabel, onConfirm, onClose }) => (
  <Sheet open={open} onClose={onClose} title={title}>
    <div className="px-2 space-y-4">
      <p className="text-[15px] leading-relaxed text-[#8b949e]">{message}</p>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 h-12 rounded-xl bg-[#21262d] text-[#e6edf3] text-[15px] font-medium active:bg-[#30363d]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 h-12 rounded-xl bg-red-500/90 text-white text-[15px] font-semibold active:bg-red-500"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </Sheet>
);
