/**
 * Bundle text (names, messages, values) for the review reports, which people paste into
 * GitHub or GitLab. Shown as the text it is: never a link, an image, HTML or emphasis, and
 * never a mention that notifies someone (#473).
 */

/** `@name` and `@org/team` with a zero-width space after the `@`, so they notify no one. */
export function withoutMentions(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@​");
}

/** HTML and Markdown escaped, on one line. `|` too, for table cells. Not for code spans, which show text as it is. */
export function escapeMarkdown(text: string): string {
  return withoutMentions(
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/[\\`*_[\]]/g, "\\$&")
      .replaceAll("|", "\\|")
      .replace(/\r?\n/g, " "),
  );
}
