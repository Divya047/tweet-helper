// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { extractVisiblePosts, findComposers, insertTextIntoComposer } from "../src/dom.js";

describe("extension DOM helpers", () => {
  it("extracts visible posts from X-like articles", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice">Alice</a>
        <div data-testid="tweetText">Local tools should keep the human in the loop.</div>
        <a href="/alice/status/123456789">time</a>
      </article>
    `;

    const posts = extractVisiblePosts(document);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "123456789",
      author: "alice",
      text: "Local tools should keep the human in the loop."
    });
  });

  it("finds and writes to a composer without submitting", () => {
    document.body.innerHTML = `<div role="textbox" contenteditable="true"></div>`;
    const composer = findComposers(document)[0]!;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false)
    });

    insertTextIntoComposer(composer, "Draft text");

    expect(composer.textContent).toBe("Draft text");
  });
});
