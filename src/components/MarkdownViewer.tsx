import type { FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Maximize2 } from "lucide-react";
import { useState } from "react";
import { WikiLink } from "./WikiLink";
import { transformWikiLinksToMarkdown } from "../utils/wikilinks/wikilinkParser";
import { resolveImageUrl } from "../services/gitVaultBridge";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  currentFilePath?: string;
  onNavigateFile?: (filePath: string, header?: string) => void;
  onCreateFile?: (newFilePath: string) => void;
  vaultPath?: string;
  onPreviewImage?: (src: string, alt?: string) => void;
}

const CodeBlock: FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-4 rounded-xl overflow-hidden border border-[#30363d] bg-[#161b22]">
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#0d1117] border-b border-[#30363d]/60 text-xs text-zinc-400 font-mono">
        <span>{className ? className.replace("language-", "") : "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-[#21262d] cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs font-mono text-zinc-200 leading-relaxed selection:bg-sky-500/30">
        <code>{children}</code>
      </pre>
    </div>
  );
};

export const MarkdownViewer: FC<MarkdownViewerProps> = ({
  content,
  className = "",
  currentFilePath,
  onNavigateFile,
  onCreateFile,
  vaultPath = "",
  onPreviewImage,
}) => {
  const transformedContent = transformWikiLinksToMarkdown(content);

  return (
    <div
      className={`markdown-viewer text-zinc-200 text-sm leading-relaxed ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold text-white mt-6 mb-4 pb-2 border-b border-[#30363d] flex items-center gap-2">
              <span className="text-sky-400 select-none font-mono text-lg font-normal">#</span>
              <span>{children}</span>
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold text-sky-200 mt-6 mb-3 pb-1.5 border-b border-[#30363d]/60 flex items-center gap-2">
              <span className="text-sky-400/70 select-none font-mono text-base font-normal">##</span>
              <span>{children}</span>
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold text-zinc-100 mt-5 mb-2 flex items-center gap-2">
              <span className="text-indigo-400/70 select-none font-mono text-sm font-normal">###</span>
              <span>{children}</span>
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold text-zinc-200 mt-4 mb-2 flex items-center gap-1.5">
              <span className="text-zinc-500 select-none font-mono text-xs font-normal">####</span>
              <span>{children}</span>
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className="text-sm font-semibold text-zinc-300 mt-3 mb-1">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mt-3 mb-1">
              {children}
            </h6>
          ),
          p: ({ children }) => <p className="my-3 leading-relaxed text-zinc-300">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 pl-4 border-l-2 border-sky-500 bg-sky-950/15 py-1 text-zinc-300 italic rounded-r-lg">
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className="my-3 pl-6 list-disc space-y-1 text-zinc-300 marker:text-sky-400">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 pl-6 list-decimal space-y-1 text-zinc-300 marker:text-sky-400">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          hr: () => <hr className="my-6 border-[#30363d]" />,
          a: ({ href, children }) => {
            if (href?.startsWith("wikilink:")) {
              const rawUri = href.slice("wikilink:".length);
              const [encodedTarget, query] = rawUri.split("?");
              const target = decodeURIComponent(encodedTarget || "");
              const searchParams = new URLSearchParams(query || "");
              const header = searchParams.get("header") || undefined;

              return (
                <WikiLink
                  target={target}
                  header={header}
                  alias={String(children)}
                  sourcePath={currentFilePath}
                  onNavigate={onNavigateFile}
                  onCreate={onCreateFile}
                />
              );
            }

            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors"
              >
                {children}
              </a>
            );
          },
          code: ({ className, children, ...props }) => {
            const isMultiLine = String(children).includes("\n");
            if (isMultiLine) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded bg-[#161b22] border border-[#30363d] text-sky-300 font-mono text-[13px]"
                {...props}
              >
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-5 overflow-x-auto rounded-xl border border-[#30363d]">
              <table className="w-full text-left text-xs border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[#161b22] text-white border-b border-[#30363d]">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-[#30363d]/50 bg-[#0d1117]">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-[#161b22]/50 transition-colors">{children}</tr>,
          th: ({ children }) => <th className="px-4 py-2.5 font-semibold text-zinc-200">{children}</th>,
          td: ({ children }) => <td className="px-4 py-2.5 text-zinc-300">{children}</td>,
          input: ({ type, checked, readOnly, ...props }) => {
            if (type === "checkbox") {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly={readOnly}
                  className="rounded border-[#30363d] text-sky-500 focus:ring-0 mr-2 accent-sky-500 align-middle pointer-events-none"
                  {...props}
                />
              );
            }
            return <input type={type} {...props} />;
          },
          img: ({ src, alt }) => {
            const resolved = resolveImageUrl(src || "", vaultPath);
            return (
              <span className="relative group my-3 inline-block max-w-full select-none">
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onPreviewImage) {
                      onPreviewImage(resolved, alt || "");
                    }
                  }}
                  className="relative rounded-xl overflow-hidden border border-[#30363d] bg-[#161b22] hover:border-purple-500/60 shadow-lg hover:shadow-purple-500/10 transition-all cursor-pointer inline-block"
                >
                  <img
                    src={resolved}
                    alt={alt}
                    className="max-h-[460px] max-w-full object-contain rounded-xl block bg-[#0d1117]/60 group-hover:scale-[1.01] transition-transform duration-200"
                    loading="lazy"
                  />
                  <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                    <span className="px-3 py-1.5 bg-[#161b22]/90 border border-purple-500/40 rounded-lg shadow-xl backdrop-blur-md flex items-center gap-1.5 text-purple-200 text-xs font-medium">
                      <Maximize2 className="w-3.5 h-3.5 text-purple-400" />
                      <span>Click to Preview</span>
                    </span>
                  </span>
                </span>
                {alt && (
                  <span className="block text-center text-xs text-zinc-400 mt-1 font-mono italic">
                    {alt}
                  </span>
                )}
              </span>
            );
          },
        }}
      >
        {transformedContent}
      </ReactMarkdown>
    </div>
  );
};
