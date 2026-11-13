import { useEffect, useState } from "react";
import type { FC } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Cloud, Smartphone } from "lucide-react";
import { ConflictFile, ConflictResolution } from "../../types/noetic";
import { useBackLayer } from "../../utils/backNavigation";

interface MobileConflictViewProps {
  conflicts: ConflictFile[];
  isOpen: boolean;
  onClose: () => void;
  onApplyResolutions: (resolutions: ConflictResolution[]) => void;
}

type Choice = "local" | "remote";

export const MobileConflictView: FC<MobileConflictViewProps> = ({ conflicts, isOpen, onClose, onApplyResolutions }) => {
  // On phones, Back closes this.
  useBackLayer(isOpen, onClose);
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    if (isOpen) {
      setIndex(0);
      setChoices({});
    }
  }, [isOpen, conflicts]);

  if (!isOpen || conflicts.length === 0) return null;

  const current = conflicts[Math.min(index, conflicts.length - 1)];
  const choice = choices[current.path];
  const remaining = conflicts.filter((c) => !choices[c.path]).length;
  const many = conflicts.length > 1;

  const choose = (c: Choice) => {
    setChoices((prev) => ({ ...prev, [current.path]: c }));
    // Step to the next unresolved file so a multi-file merge is a series of single taps.
    const next = conflicts.findIndex((f, i) => i !== index && !choices[f.path]);
    if (next !== -1) setIndex(next);
  };

  const chooseAll = (c: Choice) => setChoices(Object.fromEntries(conflicts.map((f) => [f.path, c])));

  const apply = () =>
    onApplyResolutions(
      conflicts.map((c) => {
        const type = choices[c.path];
        return {
          path: c.path,
          resolution_type: type,
          custom_content: type === "local" ? c.local_content : c.remote_content,
        };
      })
    );

  const versions: { id: Choice; label: string; keep: string; icon: typeof Cloud; content: string; accent: string; ring: string }[] = [
    {
      id: "local",
      label: "On this device",
      keep: "Keep mine",
      icon: Smartphone,
      content: current.local_content,
      accent: "text-amber-400",
      ring: "border-amber-400",
    },
    {
      id: "remote",
      label: "From another device",
      keep: "Keep the other",
      icon: Cloud,
      content: current.remote_content,
      accent: "text-sky-400",
      ring: "border-sky-400",
    },
  ];

  return (
    <div className="m-shell fixed inset-0 z-50 bg-[#0d1117] text-[#e6edf3] flex flex-col m-fade-in">
      <header className="pt-safe border-b border-[#21262d] shrink-0">
        <div className="h-14 px-1.5 flex items-center gap-0.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close without resolving"
            className="w-11 h-11 rounded-full flex items-center justify-center text-[#8b949e] active:bg-[#21262d]"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0 px-2">
            <h1 className="text-[16px] font-semibold text-[#f0f6fc] leading-tight">Resolve conflicts</h1>
            <p className="text-[12px] text-[#8b949e] leading-tight mt-0.5">
              {remaining === 0 ? "All files decided" : `${remaining} of ${conflicts.length} left to decide`}
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4">
        <p className="text-[15px] leading-relaxed text-[#8b949e]">
          This note changed both here and on another device. Choose the version to keep.
        </p>

        <div className="flex items-center gap-1">
          {many && (
            <button
              type="button"
              aria-label="Previous file"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
              className="w-11 h-11 rounded-full flex items-center justify-center text-[#8b949e] active:bg-[#21262d] disabled:opacity-30"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <div className="flex-1 min-w-0 text-center">
            <p className="font-mono text-[14px] text-[#f0f6fc] truncate">{current.path}</p>
            {many && (
              <p className="text-[12px] text-[#8b949e]">
                File {index + 1} of {conflicts.length}
              </p>
            )}
          </div>
          {many && (
            <button
              type="button"
              aria-label="Next file"
              disabled={index >= conflicts.length - 1}
              onClick={() => setIndex(index + 1)}
              className="w-11 h-11 rounded-full flex items-center justify-center text-[#8b949e] active:bg-[#21262d] disabled:opacity-30"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {versions.map((v) => {
          const selected = choice === v.id;
          return (
            <section
              key={v.id}
              className={`rounded-2xl bg-[#161b22] border-2 overflow-hidden transition-colors ${
                selected ? v.ring : "border-[#21262d]"
              }`}
            >
              <div className="px-4 pt-3.5 pb-2 flex items-center gap-2">
                <v.icon className={`w-4 h-4 ${v.accent}`} />
                <h2 className="text-[14px] font-semibold text-[#f0f6fc]">{v.label}</h2>
              </div>
              <pre className="mx-4 rounded-xl bg-[#0d1117] border border-[#21262d] p-3 font-mono text-[13px] leading-relaxed text-[#c9d1d9] whitespace-pre-wrap break-words max-h-52 overflow-y-auto select-text">
                {v.content || "(empty file)"}
              </pre>
              <div className="p-4">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => choose(v.id)}
                  className={`w-full h-12 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-2 transition-colors ${
                    selected ? "bg-[#f0f6fc] text-[#0d1117]" : "bg-[#21262d] text-[#f0f6fc] active:bg-[#30363d]"
                  }`}
                >
                  {selected && <Check className="w-4 h-4" />}
                  <span>{selected ? `Keeping ${v.id === "local" ? "mine" : "the other"}` : v.keep}</span>
                </button>
              </div>
            </section>
          );
        })}

        {many && (
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => chooseAll("local")}
              className="flex-1 h-11 rounded-xl border border-[#30363d] text-[14px] font-medium text-[#c9d1d9] active:bg-[#161b22]"
            >
              Keep mine for all
            </button>
            <button
              type="button"
              onClick={() => chooseAll("remote")}
              className="flex-1 h-11 rounded-xl border border-[#30363d] text-[14px] font-medium text-[#c9d1d9] active:bg-[#161b22]"
            >
              Keep the other for all
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[#21262d] bg-[#161b22] pb-safe">
        <div className="p-3 max-w-xl mx-auto">
          <button
            type="button"
            disabled={remaining > 0}
            onClick={apply}
            className="w-full h-[52px] rounded-xl bg-sky-500 text-[#04121d] text-[16px] font-semibold active:bg-sky-400 disabled:bg-[#21262d] disabled:text-[#8b949e]"
          >
            {remaining > 0
              ? many
                ? `Choose for ${remaining} more file${remaining === 1 ? "" : "s"}`
                : "Choose a version to continue"
              : "Apply and finish"}
          </button>
        </div>
      </div>
    </div>
  );
};
