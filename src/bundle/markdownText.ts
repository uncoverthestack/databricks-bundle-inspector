import { withVisibleDirectionControls } from "./visibleText.js";

/**
 * Bundle text (names, messages, values) for the review reports, which people paste into
 * GitHub or GitLab. Shown as the text it is: never a link, an image, HTML or emphasis, and
 * never a mention that notifies someone (#473).
 */

/** `@name` and `@org/team` with a zero-width space after the `@`, so they notify no one. */
export function withoutMentions(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@​");
}

/**
 * Web addresses with a zero-width space where GitHub would start a link: after the `:` of
 * `http:`/`https:` (any letter case) and before the `.` of `www.`. Checked with GitHub's own
 * Markdown renderer (`POST /markdown`, gfm): `https://example.com` and `www.example.com` become
 * links, `https:` + U+200B + `//example.com` and `www` + U+200B + `.example.com` stay text.
 * Emails need nothing here: {@link withoutMentions} already breaks them after the `@`.
 */
export function withoutAutolinks(text: string): string {
  return text.replace(/\b(https?):(?=\/\/)/gi, "$1:​").replace(/\b(www)(?=\.)/gi, "$1​");
}

/** HTML and Markdown escaped, on one line. `|` too, for table cells. Not for code spans, which show text as it is. */
export function escapeMarkdown(text: string): string {
  return withoutAutolinks(
    withoutMentions(
      withVisibleDirectionControls(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/[\\`*_[\]]/g, "\\$&")
        .replaceAll("|", "\\|")
        .replace(/\r?\n/g, " "),
    ),
  );
}

/** Inline code on one line that survives backticks and `|` inside it. A code span shows its text as it is. */
export function markdownCode(text: string): string {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const runs = flat.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  // CommonMark removes one space from both ends when the content is not all spaces.
  // Pad such values so their own leading and trailing spaces survive rendering.
  const needsPadding = runs.length > 0 || (flat.startsWith(" ") && flat.endsWith(" ") && /[^ ]/.test(flat));
  return needsPadding ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}
