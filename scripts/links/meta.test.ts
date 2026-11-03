import { describe, expect, test } from "bun:test";
import {
  fetchLinkCard,
  parseFetchableUrl,
  parseLinkMeta,
  type Fetch,
  type Lookup,
} from "./meta";

const URL_A = "https://www.example.com/a/";

describe("parseLinkMeta", () => {
  test("prefers Open Graph tags", () => {
    const html = `<html><head>
      <title>Plain title</title>
      <meta name="description" content="Plain description">
      <meta property="og:title" content="OG title">
      <meta content='OG description' property='og:description'>
      <meta property="og:site_name" content="Example Site">
    </head><body><title>Not this</title></body></html>`;
    expect(parseLinkMeta({ html, url: URL_A })).toEqual({
      site: "Example Site",
      title: "OG title",
      description: "OG description",
    });
  });

  test("falls back to twitter, then the title and meta description", () => {
    expect(
      parseLinkMeta({
        html: '<meta name="twitter:title" content="Tweet title"><meta name="twitter:description" content="Tweet description">',
        url: URL_A,
      }),
    ).toEqual({
      site: "example.com",
      title: "Tweet title",
      description: "Tweet description",
    });
    expect(
      parseLinkMeta({
        html: '<head><TITLE lang="en">\n  Page\n  title </TITLE><meta name=Description content="Meta description"><meta name="twitter:description" content="no"></head>',
        url: URL_A,
      }),
    ).toEqual({
      site: "example.com",
      title: "Page title",
      description: "Meta description",
    });
  });

  test("uses the URL as the title of a page with no title", () => {
    expect(parseLinkMeta({ html: "<p>hi</p>", url: URL_A })).toEqual({
      site: "example.com",
      title: "www.example.com/a",
    });
  });

  test("ignores empty values", () => {
    expect(
      parseLinkMeta({
        html: '<meta property="og:title" content="  "><title>Real</title><meta property="og:description" content="">',
        url: URL_A,
      }),
    ).toEqual({ site: "example.com", title: "Real" });
  });

  test("decodes entities and collapses whitespace", () => {
    expect(
      parseLinkMeta({
        html: "<title>Tom &amp; Jerry&#39;s &#x2014; &quot;best&quot;&nbsp;of\n\t&hellip; &bogus; &#0;</title>",
        url: URL_A,
      }).title,
    ).toBe('Tom & Jerry\'s — "best" of … &bogus; &#0;');
  });

  test("cuts a long title and description at a word", () => {
    const words = (count: number) =>
      Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
    const { title, description = "" } = parseLinkMeta({
      html: `<title>${words(40)}</title><meta name="description" content="${words(80)}">`,
      url: URL_A,
    });
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title).toMatch(/ word\d+…$/);
    expect(description.length).toBeLessThanOrEqual(301);
    expect(description).toMatch(/ word\d+…$/);
  });

  test("cuts a long word where it must", () => {
    const { title } = parseLinkMeta({
      html: `<title>${"x".repeat(200)}</title>`,
      url: URL_A,
    });
    expect(title).toBe(`${"x".repeat(120)}…`);
  });
});

describe("parseFetchableUrl", () => {
  test.each([
    "https://example.com/",
    "http://example.com/a?b=c",
    "https://sub.example.co.uk",
    "https://8.8.8.8/",
    "https://[2606:4700::1111]/",
    "https://100.128.0.1/",
    "https://192.0.1.1/",
    "https://[64:ff9b::808:808]/",
    "https://[2002:808:808::1]/",
  ])("accepts %s", (url) => {
    expect(parseFetchableUrl(url)?.href).toBe(new URL(url).href);
  });

  test.each([
    "ftp://example.com/",
    "javascript:alert(1)",
    "not a url",
    "https://user:pass@example.com/",
    "http://localhost:4321/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://nas/",
    "http://nas./",
    "http://router.home.arpa/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.88.16/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fd7a:115c:a1e0::1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:7f00:1]/",
    "http://192.0.0.1/",
    "http://[64:ff9b::a00:1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:c0a8:101::1]/",
    "http://[2002:7f00:1::]/",
    "http://[::ffff:0:a00:1]/",
    "http://[::ffff:0:127.0.0.1]/",
    "http://[fec0::1]/",
  ])("refuses %s", (url) => {
    expect(parseFetchableUrl(url)).toBeUndefined();
  });
});

describe("fetchLinkCard", () => {
  const PAGE =
    '<html><head><title>A page</title><meta name="description" content="About it"></head></html>';
  const publicLookup: Lookup = async () => ["93.184.215.14"];

  const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });

  const recording = (answer: (url: string) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, init });
      return answer(url);
    };
    return { calls, fetch };
  };

  test("reads the card, with a user agent and no automatic redirects", async () => {
    const { calls, fetch } = recording(() => html(PAGE));
    expect(
      await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }),
    ).toEqual({
      site: "example.com",
      title: "A page",
      description: "About it",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.init.redirect).toBe("manual");
    expect(new Headers(call?.init.headers).get("user-agent")).toBe(
      "neorp-link-card (+https://reesep.com)",
    );
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("follows a redirect to a public page", async () => {
    const { calls, fetch } = recording((url) =>
      url === URL_A
        ? new Response(null, {
            status: 301,
            headers: { location: "https://other.example.org/b" },
          })
        : html(PAGE),
    );
    expect(
      await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }),
    ).toEqual({
      site: "other.example.org",
      title: "A page",
      description: "About it",
    });
    expect(calls.map(({ url }) => url)).toEqual([
      URL_A,
      "https://other.example.org/b",
    ]);
  });

  test.each([
    ["a redirect into the LAN", "http://192.168.88.16/api/pads"],
    ["a redirect to localhost", "http://localhost/"],
    ["a redirect to another scheme", "file:///etc/passwd"],
  ])("refuses %s", async (_, location) => {
    const { calls, fetch } = recording(
      () => new Response(null, { status: 302, headers: { location } }),
    );
    expect(
      await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("stops after five redirects", async () => {
    const { calls, fetch } = recording(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://example.com/${Math.random()}` },
        }),
    );
    expect(
      await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }),
    ).toBeUndefined();
    expect(calls).toHaveLength(6);
  });

  test("refuses a public name that resolves into the LAN", async () => {
    const { calls, fetch } = recording(() => html(PAGE));
    expect(
      await fetchLinkCard({
        url: "https://compose.reesep.com/",
        fetch,
        lookup: async () => ["192.168.88.16"],
      }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("refuses a URL it may not fetch, with no request", async () => {
    const { calls, fetch } = recording(() => html(PAGE));
    expect(
      await fetchLinkCard({
        url: "http://10.0.0.1/",
        fetch,
        lookup: publicLookup,
      }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test.each([
    [
      "an error status",
      () =>
        new Response(PAGE, {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "a PDF",
      () =>
        new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        }),
    ],
    ["no content type", () => new Response(PAGE)],
    [
      "a fetch that throws",
      () => {
        throw new Error("offline");
      },
    ],
  ])("gives nothing for %s", async (_, answer) => {
    const { fetch } = recording(answer);
    expect(
      await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }),
    ).toBeUndefined();
  });

  test("accepts XHTML", async () => {
    const { fetch } = recording(() =>
      html(PAGE, { "content-type": "application/xhtml+xml" }),
    );
    expect(
      (await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }))?.title,
    ).toBe("A page");
  });

  test("gives nothing when the page is too slow", async () => {
    const fetch: Fetch = (_, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    expect(
      await fetchLinkCard({
        url: URL_A,
        fetch,
        lookup: publicLookup,
        timeoutMs: 20,
      }),
    ).toBeUndefined();
  });

  test("reads only the first megabyte", async () => {
    const pulled: number[] = [];
    const chunk = new TextEncoder().encode(
      `<!--${"x".repeat(64 * 1024 - 7)}-->`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<title>Big</title>"));
      },
      pull(controller) {
        pulled.push(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    const { fetch } = recording(
      () => new Response(body, { headers: { "content-type": "text/html" } }),
    );
    expect(
      (await fetchLinkCard({ url: URL_A, fetch, lookup: publicLookup }))?.title,
    ).toBe("Big");
    expect(pulled.length).toBeLessThan(20);
  });
});
