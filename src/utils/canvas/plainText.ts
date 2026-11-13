/**
 * Removes Markdown formatting characters ("#", "*", "_", "~", "`", ">", list bullets, link
 * brackets) from a one-line label, keeping the words. Canvas cards never show raw Markdown.
 */
export function stripMarkdownMarkers(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias || target) // [[wikilinks]]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url)
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?)/, "") // heading / quote / bullet
    .replace(/(\*\*|\*|~~|`)(\S(?:.*?\S)?)\1/g, "$2") // **bold**, *italic*, ~~strike~~, `code`
    .replace(/(^|\W)(__?)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3") // __bold__, _italic_ (not snake_case)
    .replace(/[*#`~]/g, "") // stray markers
    .replace(/\s{2,}/g, " ")
    .trim();
}
