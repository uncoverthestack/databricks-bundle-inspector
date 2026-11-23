import { describe, expect, test } from "@jest/globals";
import { escapeMarkdown, markdownCode, withoutMentions } from "../../../bundle/markdownText.js";

describe("markdownText (#473)", () => {
  test("a mention notifies no one, and an email or a lone @ stays readable", () => {
    expect(withoutMentions("@alice and @org/team")).toBe("@​alice and @​org/team");
    expect(withoutMentions("me@example.com")).toBe("me@​example.com");
    expect(withoutMentions("a @ b")).toBe("a @ b");
  });

  test("links, images, HTML, emphasis and table pipes are text", () => {
    expect(escapeMarkdown("[a](u) ![i](p) <b>x</b> *y* _z_ a|b `c` \\ &")).toBe(
      "\\[a\\](u) !\\[i\\](p) &lt;b&gt;x&lt;/b&gt; \\*y\\* \\_z\\_ a\\|b \\`c\\` \\\\ &amp;",
    );
  });

  test("one line", () => {
    expect(escapeMarkdown("a\r\nb\nc")).toBe("a b c");
  });

  test("code spans survive backticks and pipes, on one line (#486)", () => {
    expect(markdownCode("run_date")).toBe("`run_date`");
    expect(markdownCode("a`b")).toBe("`` a`b ``");
    expect(markdownCode("a``b`c")).toBe("``` a``b`c ```");
    expect(markdownCode("a|b\nc")).toBe("`a\\|b c`");
  });
});
