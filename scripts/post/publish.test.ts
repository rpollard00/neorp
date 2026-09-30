import { describe, expect, test } from "bun:test";
import { parsePost } from "./post-file";
import { parseDay } from "./publish";

describe("parseDay", () => {
  test("reads a real date as the same instant the frontmatter parser gives", () => {
    const parsed = parsePost({
      path: "/posts/a.md",
      slug: "a",
      source: "---\ntitle: t\npubDate: 2026-10-05\n---\n",
    });
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parseDay("2026-10-05")).toEqual(parsed.post.data.pubDate);
  });

  test.each([
    "2026-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-4-01",
    "26-04-01",
    "2026-04-01T00:00",
    "tomorrow",
    "",
  ])("rejects %p", (text) => {
    expect(parseDay(text)).toBeUndefined();
  });

  test("accepts a leap day", () => {
    expect(parseDay("2028-02-29")).toBeDefined();
  });
});
