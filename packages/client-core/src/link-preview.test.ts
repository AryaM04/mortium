// Tests for the link finder of the sender-side link preview, and for the
// web platform's server fetcher (it never throws, and it decodes the image).
import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "@mortium/shared";
import type { ApiClient } from "./api.js";
import { createServerLinkPreviewFetcher, findFirstLink } from "./link-preview.js";

describe("findFirstLink", () => {
  it("finds the first http or https link", () => {
    expect(findFirstLink("see https://example.com/a and http://example.org")).toBe(
      "https://example.com/a",
    );
    expect(findFirstLink("plain text")).toBeNull();
    expect(findFirstLink("ftp://example.com")).toBeNull();
  });

  it("removes punctuation and an unmatched bracket after the link", () => {
    expect(findFirstLink("Look: https://example.com/page.")).toBe("https://example.com/page");
    expect(findFirstLink("(https://example.com/a)")).toBe("https://example.com/a");
    expect(findFirstLink("https://en.wikipedia.org/wiki/Foo_(bar)!")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });

  it("skips a link in angle brackets, which asks for no preview", () => {
    expect(findFirstLink("<https://example.com/a> https://example.com/b")).toBe(
      "https://example.com/b",
    );
    expect(findFirstLink("<https://example.com/a>")).toBeNull();
  });
});

describe("createServerLinkPreviewFetcher", () => {
  function fakeApi(result: () => Promise<unknown>): ApiClient {
    return { request: result } as unknown as ApiClient;
  }

  it("decodes the image and keeps the URL that the user wrote", async () => {
    const fetchPreview = createServerLinkPreviewFetcher(
      fakeApi(async () => ({
        url: "https://example.com/after-redirect",
        title: "T",
        image: { mime: "image/png", data: encodeBase64Url(new Uint8Array([1, 2, 3])) },
      })),
    );
    const preview = await fetchPreview("https://example.com/");
    expect(preview?.url).toBe("https://example.com/");
    expect(preview?.title).toBe("T");
    expect([...(preview?.image?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it("gives null when the server has no preview", async () => {
    const fetchPreview = createServerLinkPreviewFetcher(
      fakeApi(async () => Promise.reject(new Error("422"))),
    );
    expect(await fetchPreview("https://example.com/")).toBeNull();
  });
});
