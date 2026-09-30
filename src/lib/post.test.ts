import { describe, expect, test } from "bun:test";
import { formatDay, postSchema, postState, siteToday } from "./post";

const pubDate = new Date("2026-09-30");

describe("postState", () => {
  test("is scheduled while the date has not started in the site's timezone", () => {
    expect(postState({ pubDate }, new Date("2026-09-30T01:00Z")).kind).toBe(
      "scheduled",
    );
  });

  test("is published once the date starts in the site's timezone", () => {
    expect(postState({ pubDate }, new Date("2026-09-30T08:00Z")).kind).toBe(
      "published",
    );
  });

  test("is a draft without a date", () => {
    expect(postState({}, new Date()).kind).toBe("draft");
  });
});

describe("siteToday", () => {
  test("is the site's calendar date at UTC midnight", () => {
    expect(formatDay(siteToday(new Date("2026-09-30T06:59Z")))).toBe(
      "2026-09-29",
    );
    expect(siteToday(new Date("2026-09-30T07:00Z"))).toEqual(pubDate);
  });
});

describe("postSchema pubDate", () => {
  test("takes a date and treats null as no date", () => {
    expect(postSchema.parse({ title: "t", pubDate }).pubDate).toEqual(pubDate);
    expect(postSchema.parse({ title: "t", pubDate: null }).pubDate).toBe(
      undefined,
    );
  });

  test("rejects a string instead of guessing", () => {
    expect(
      postSchema.safeParse({ title: "t", pubDate: "2026-09-30" }).success,
    ).toBe(false);
  });
});
