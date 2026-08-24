import { describe, expect, it } from "vitest";
import { excerpt, htmlToText } from "../../src/text/html.js";

describe("htmlToText", () => {
  it("returns an empty string for null or undefined", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText("")).toBe("");
  });

  it("turns block tags into line breaks and drops inline tags", () => {
    // A closing </p> and the next opening <p> each yield a newline, so
    // paragraphs end up separated by a blank line — which is what a reader
    // expects when the page is printed back.
    expect(htmlToText("<p>الأول</p><p>الثاني</p>")).toBe("الأول\n\nالثاني");
    // One closing tag with no opening tag after it yields a single newline.
    expect(htmlToText("<div>الأول</div>الثاني")).toBe("الأول\nالثاني");
    expect(htmlToText("سطر<br/>سطر")).toBe("سطر\nسطر");
    expect(htmlToText("نص <b>عريض</b> هنا")).toBe("نص عريض هنا");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("&laquo;الطهارة&raquo;")).toBe("«الطهارة»");
    expect(htmlToText("&#1575;&#1604;&#1576;")).toBe("الب");
    expect(htmlToText("&#x627;&#x644;&#x628;")).toBe("الب");
    expect(htmlToText("a &amp; b")).toBe("a & b");
  });

  it("leaves an unknown entity alone rather than mangling it", () => {
    expect(htmlToText("&notanentity;")).toBe("&notanentity;");
  });

  it("removes comments, scripts and styles", () => {
    expect(htmlToText("قبل<!-- تعليق -->بعد")).toBe("قبلبعد");
    expect(htmlToText("<script>alert(1)</script>نص")).toBe("نص");
    expect(htmlToText("<style>p{}</style>نص")).toBe("نص");
  });

  it("preserves the words themselves, including diacritics", () => {
    expect(htmlToText("<p>الصَّلَاةُ وَاجِبَةٌ</p>")).toBe("الصَّلَاةُ وَاجِبَةٌ");
  });

  it("collapses runs of blank lines but keeps paragraph separation", () => {
    expect(htmlToText("<p>أ</p><br/><br/><br/><p>ب</p>")).toBe("أ\n\nب");
  });
});

describe("excerpt", () => {
  const long = Array.from({ length: 80 }, (_, i) => `كلمة${i}`).join(" ");

  it("returns short text unchanged", () => {
    expect(excerpt("نص قصير", 0)).toBe("نص قصير");
  });

  it("marks elision on both sides when cutting from the middle", () => {
    const out = excerpt(long, Math.floor(long.length / 2), 40);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never slices a word in half", () => {
    const out = excerpt(long, 300, 40).replace(/^…\s*|\s*…$/g, "");
    for (const token of out.split(/\s+/)) {
      expect(long).toContain(token);
    }
  });

  it("does not mark elision at the start when the window begins at 0", () => {
    expect(excerpt(long, 0, 40).startsWith("…")).toBe(false);
  });
});
