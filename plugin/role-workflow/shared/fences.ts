/**
 * Removes fenced code blocks so quoted examples are inert. Fences open only at the start of a
 * line, as in Markdown: three backticks in the middle of prose must not hide the lines after
 * them. A fence closes on a line of the same character at least as long; an unclosed fence
 * runs to the end, as it renders.
 */
export function stripFences(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; size: number } | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      continue;
    }
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string cannot contain a backtick; such a line is inline code.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], size: open[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
