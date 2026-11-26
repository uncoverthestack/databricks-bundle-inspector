import { describe, expect, test } from "@jest/globals";
import { escapeMarkdown, markdownCode, withoutAutolinks, withoutMentions } from "../../../bundle/markdownText.js";

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

  test("code spans preserve spaces at both ends without changing one-sided or all-space values (#595)", () => {
    expect(markdownCode(" value ")).toBe("`  value  `");
    expect(markdownCode(" value")).toBe("` value`");
    expect(markdownCode("value ")).toBe("`value `");
    expect(markdownCode("   ")).toBe("`   `");
    expect(markdownCode(" `value` ")).toBe("``  `value`  ``");
  });
});

// GitHub's renderer (POST /markdown, gfm, 2026-11-25) linked each "links" case as written, and
// none with the zero-width space; WWW. and Www. were never linked, and emails are already
// broken after the @ by withoutMentions.
describe("withoutAutolinks: addresses GitHub would link stay text", () => {
  const ZW = "​";
  test.each([
    ["https://example.com", `https:${ZW}//example.com`],
    ["http://x.io/a?b=c", `http:${ZW}//x.io/a?b=c`],
    ["HTTPS://X.IO and Http://y.io", `HTTPS:${ZW}//X.IO and Http:${ZW}//y.io`],
    ["www.example.com", `www${ZW}.example.com`],
    ["(see www.x.io/docs)", `(see www${ZW}.x.io/docs)`],
  ])("%s", (input, expected) => {
    expect(withoutAutolinks(input)).toBe(expected);
  });

  test.each([["ftp://example.com"], ["xwww.example.com"], ["https:example"], ["schema.https_table"], ["a www b"]])("leaves %s alone", (input) => {
    expect(withoutAutolinks(input)).toBe(input);
  });

  test("escapeMarkdown breaks every link GitHub would make from bundle text", () => {
    expect(escapeMarkdown("ops https://example.com www.example.com ops@example.com")).toBe(
      `ops https:${ZW}//example.com www${ZW}.example.com ops@${ZW}example.com`,
    );
  });

  test("code spans are left as written: GitHub never links inside them", () => {
    expect(markdownCode("https://example.com")).toBe("`https://example.com`");
  });
});
