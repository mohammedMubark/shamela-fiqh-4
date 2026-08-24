/**
 * Shamela stores page bodies as light HTML. This turns that markup back into
 * readable plain text while changing as little as possible: tags become line
 * structure, entities are decoded, and no word is ever rewritten. The result is
 * `text_original` — the only string quoted back to the user.
 */

const BLOCK_TAGS = /<\/?(?:p|div|br|tr|li|h[1-6]|blockquote|hr|table|section)\b[^>]*>/gi;
const ANY_TAG = /<[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Convert a stored page body to plain text.
 * Block-level tags become newlines so paragraphs and verse lines survive;
 * inline tags simply vanish.
 */
export function htmlToText(raw: string | null | undefined): string {
  if (!raw) return "";
  return decodeEntities(
    String(raw)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(BLOCK_TAGS, "\n")
      .replace(ANY_TAG, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A short, whole-word excerpt centred on the first match, used for previews.
 * Cut on token boundaries so we never slice a word in half, and mark elisions
 * with an ellipsis so the reader can tell the passage is partial.
 */
export function excerpt(text: string, around: number, radius = 160): string {
  if (text.length <= radius * 2) return text;
  const start = Math.max(0, around - radius);
  const end = Math.min(text.length, around + radius);
  let s = start;
  let e = end;
  while (s > 0 && !/\s/.test(text[s - 1] ?? " ")) s--;
  while (e < text.length && !/\s/.test(text[e] ?? " ")) e++;
  return `${s > 0 ? "… " : ""}${text.slice(s, e).trim()}${e < text.length ? " …" : ""}`;
}
