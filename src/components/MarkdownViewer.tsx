import type { FC } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Maximize2 } from "lucide-react";
import { useState, useMemo } from "react";
import { WikiLink } from "./WikiLink";
import { transformWikiLinksToMarkdown } from "../utils/wikilinks/wikilinkParser";
import { resolveImageUrl } from "../services/gitVaultBridge";

const REMARK_PLUGINS = [remarkGfm];

interface MarkdownViewerProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  fontSize?: number;
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
    <div className="relative group my-[0.6em] rounded-xl overflow-hidden border border-[#30363d] bg-[#161b22]">
      <div className="flex items-center justify-between px-[0.8em] py-[0.35em] bg-[#0d1117] border-b border-[#30363d]/60 text-[0.8em] text-zinc-400 font-mono">
        <span>{className ? className.replace("language-", "") : "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[0.9em] hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-[#21262d] cursor-pointer"
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
      <pre className="p-[0.8em] overflow-x-auto text-[0.88em] font-mono text-zinc-200 leading-relaxed selection:bg-sky-500/30">
        <code>{children}</code>
      </pre>
    </div>
  );
};

export const MarkdownViewer: FC<MarkdownViewerProps> = ({
  content,
  className = "",
  style,
  fontSize,
  currentFilePath,
  onNavigateFile,
  onCreateFile,
  vaultPath = "",
  onPreviewImage,
}) => {
  const transformedContent = transformWikiLinksToMarkdown(content);

  const markdownComponents: Components = useMemo(
    () => ({
      h1: ({ children }) => (
        <h1 className="text-[1.65em] font-bold text-white mt-[0.6em] first:mt-0 mb-[0.35em] pb-[0.2em] border-b border-[#30363d] flex items-center gap-[0.3em] leading-tight">
          <span className="text-sky-400 select-none font-mono text-[0.75em] font-normal">#</span>
          <span>{children}</span>
        </h1>
      ),
          h2: ({ children }) => (
            <h2 className="text-[1.35em] font-bold text-sky-200 mt-[0.6em] first:mt-0 mb-[0.3em] pb-[0.15em] border-b border-[#30363d]/60 flex items-center gap-[0.3em] leading-snug">
              <span className="text-sky-400/70 select-none font-mono text-[0.75em] font-normal">##</span>
              <span>{children}</span>
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[1.2em] font-semibold text-zinc-100 mt-[0.5em] first:mt-0 mb-[0.25em] flex items-center gap-[0.3em] leading-snug">
              <span className="text-indigo-400/70 select-none font-mono text-[0.75em] font-normal">###</span>
              <span>{children}</span>
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[1.08em] font-semibold text-zinc-200 mt-[0.4em] first:mt-0 mb-[0.2em] flex items-center gap-[0.25em] leading-snug">
              <span className="text-zinc-500 select-none font-mono text-[0.75em] font-normal">####</span>
              <span>{children}</span>
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className="text-[1.0em] font-semibold text-zinc-300 mt-[0.35em] first:mt-0 mb-[0.15em] leading-snug">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="text-[0.88em] font-semibold uppercase tracking-wider text-zinc-400 mt-[0.35em] first:mt-0 mb-[0.15em] leading-snug">
              {children}
            </h6>
          ),
          p: ({ children }) => <p className="my-[0.5em] first:mt-0 last:mb-0 leading-relaxed text-zinc-300">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-[0.5em] pl-[0.8em] border-l-2 border-sky-500 bg-sky-950/15 py-[0.2em] text-zinc-300 italic rounded-r-lg">
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className="my-[0.4em] pl-[1.4em] list-disc space-y-[0.25em] text-zinc-300 marker:text-sky-400">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-[0.4em] pl-[1.4em] list-decimal space-y-[0.25em] text-zinc-300 marker:text-sky-400">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          hr: () => <hr className="my-[0.8em] border-[#30363d]" />,
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
                className="px-[0.35em] py-[0.12em] rounded bg-[#161b22] border border-[#30363d] text-sky-300 font-mono text-[0.88em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-[0.6em] overflow-x-auto rounded-xl border border-[#30363d]">
              <table className="w-full text-left text-[0.88em] border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[#161b22] text-white border-b border-[#30363d]">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-[#30363d]/50 bg-[#0d1117]">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-[#161b22]/50 transition-colors">{children}</tr>,
          th: ({ children }) => <th className="px-[0.8em] py-[0.45em] font-semibold text-zinc-200">{children}</th>,
          td: ({ children }) => <td className="px-[0.8em] py-[0.45em] text-zinc-300">{children}</td>,
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
                  <span className="block text-center text-[0.85em] text-zinc-400 mt-1 font-mono italic">
                    {alt}
                  </span>
                )}
              </span>
            );
          },
        }),
    [currentFilePath, onNavigateFile, onCreateFile, vaultPath, onPreviewImage]
  );

  return (
    <div
      className={`markdown-viewer text-zinc-200 leading-relaxed ${className}`}
      style={{
        ...(fontSize ? { fontSize: `${fontSize}px` } : {}),
        ...style,
      }}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={markdownComponents}
      >
        {transformedContent}
      </ReactMarkdown>
    </div>
  );
};
