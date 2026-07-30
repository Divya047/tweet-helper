// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { expandTruncatedPostText, extractVisiblePosts, collectFeedPosts, findComposers, findTweetArticle, getComposerActionPlacement, getComposerContext, getNearestSourcePost, insertTextIntoComposer } from "../src/dom.js";

describe("extension DOM helpers", () => {
  it("clicks X show-more controls before extracting post text", async () => {
    document.body.innerHTML = `<article data-testid="tweet"><div data-testid="tweetText">Truncated post text that is long enough.</div><button data-testid="tweet-text-show-more-link">Show more</button></article>`;
    const article = document.querySelector<HTMLElement>("article")!;
    vi.spyOn(article, "getBoundingClientRect").mockReturnValue(createRect({ top: 10, bottom: 90 }));
    const button = document.querySelector<HTMLButtonElement>("button")!;
    button.addEventListener("click", () => { document.querySelector('[data-testid="tweetText"]')!.textContent = "The complete expanded post text is now available to the AI."; });

    expect(await expandTruncatedPostText(document, true)).toBe(1);
    expect(extractVisiblePosts(document)[0]?.text).toBe("The complete expanded post text is now available to the AI.");
  });

  it("extracts visible posts from X-like articles", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice">Alice</a>
        <div data-testid="tweetText">Local tools should keep the human in the loop.</div>
        <a href="/alice/status/123456789">time</a>
      </article>
    `;
    const article = document.querySelector("article")!;
    vi.spyOn(article, "getBoundingClientRect").mockReturnValue(createRect({ top: 10, bottom: 90 }));

    const posts = extractVisiblePosts(document);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "123456789",
      author: "alice",
      text: "Local tools should keep the human in the loop."
    });
  });

  it("keeps a feed post's text attached to its own link when it contains a quote", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/mainauthor">Main Author</a>
        <a href="/mainauthor/status/111111111">2h</a>
        <div data-testid="tweetText">The main post is the reply opportunity that should be queued.</div>
        <div class="quoted-post">
          <a href="/quotedauthor">Quoted Author</a>
          <a href="/quotedauthor/status/222222222">1h</a>
          <div data-testid="tweetText">The nested quote must not supply the Open post link.</div>
        </div>
      </article>
    `;
    const article = document.querySelector("article")!;
    vi.spyOn(article, "getBoundingClientRect").mockReturnValue(createRect({ top: 10, bottom: 190 }));

    const posts = extractVisiblePosts(document);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "111111111",
      author: "mainauthor",
      text: "The main post is the reply opportunity that should be queued."
    });
    expect(posts[0]?.url).toContain("/mainauthor/status/111111111");
  });

  it("finds a tweet article by status id for open-post navigation", () => {
    document.body.innerHTML = `
      <article data-testid="tweet" id="a">
        <a href="/alice">Alice</a>
        <div data-testid="tweetText">First post that is long enough to matter here.</div>
        <a href="/alice/status/111">time</a>
      </article>
      <article data-testid="tweet" id="b">
        <a href="/bob">Bob</a>
        <div data-testid="tweetText">Second post that is long enough to matter here.</div>
        <a href="/bob/status/222">time</a>
      </article>
    `;

    const found = findTweetArticle(document, { id: "222", text: "unused" });
    expect(found?.id).toBe("b");
  });

  it("collects posts across mocked feed scrolls until the candidate cap", async () => {
    const pages = [
      `<article data-testid="tweet"><a href="/a1">A</a><div data-testid="tweetText">First visible post that is long enough.</div><a href="/a1/status/1">t</a></article>
       <article data-testid="tweet"><a href="/a2">A</a><div data-testid="tweetText">Second visible post that is long enough.</div><a href="/a2/status/2">t</a></article>`,
      `<article data-testid="tweet"><a href="/a3">A</a><div data-testid="tweetText">Third visible post that is long enough.</div><a href="/a3/status/3">t</a></article>
       <article data-testid="tweet"><a href="/a4">A</a><div data-testid="tweetText">Fourth visible post that is long enough.</div><a href="/a4/status/4">t</a></article>`
    ];
    let page = 0;
    const mount = (): void => {
      document.body.innerHTML = pages[Math.min(page, pages.length - 1)]!;
      for (const article of document.querySelectorAll("article")) {
        vi.spyOn(article as HTMLElement, "getBoundingClientRect").mockReturnValue(createRect({ top: 20, bottom: 120 }));
      }
    };
    mount();

    const result = await collectFeedPosts({
      maxCandidates: 4,
      maxScrolls: 5,
      pauseMs: 0,
      stagnantLimit: 3,
      wait: async () => undefined,
      scroll: () => {
        page += 1;
        mount();
      }
    });

    expect(result.posts.map((post) => post.id)).toEqual(["1", "2", "3", "4"]);
    expect(result.scrolls).toBeGreaterThanOrEqual(1);
    expect(result.stoppedReason).toBe("cap");
  });

  it("stops a long feed scroll when duration elapses or abort fires", async () => {
    document.body.innerHTML = `<article data-testid="tweet"><a href="/a">A</a><div data-testid="tweetText">Visible post that is long enough to collect.</div><a href="/a/status/9">t</a></article>`;
    const article = document.querySelector("article")!;
    vi.spyOn(article as HTMLElement, "getBoundingClientRect").mockReturnValue(createRect({ top: 20, bottom: 120 }));

    let clock = 0;
    const progress: Array<{ posts: number; scrolls: number }> = [];
    const abort = new AbortController();
    const durationResult = await collectFeedPosts({
      maxCandidates: 40,
      maxScrolls: 40,
      pauseMs: 0,
      stagnantLimit: 99,
      maxDurationMs: 1_500,
      now: () => clock,
      wait: async () => {
        clock += 800;
      },
      scroll: () => {
        clock += 100;
      },
      onProgress: (value) => progress.push({ posts: value.posts, scrolls: value.scrolls })
    });
    expect(durationResult.stoppedReason).toBe("duration");
    expect(durationResult.elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(progress.length).toBeGreaterThan(0);

    clock = 0;
    const aborted = collectFeedPosts({
      maxCandidates: 40,
      maxScrolls: 40,
      pauseMs: 0,
      stagnantLimit: 99,
      maxDurationMs: 60_000,
      signal: abort.signal,
      now: () => clock,
      wait: async () => {
        clock += 200;
        if (clock >= 400) abort.abort();
      },
      scroll: () => undefined
    });
    await expect(aborted).resolves.toMatchObject({ stoppedReason: "aborted" });
  });

  it("ignores posts left in the DOM outside the viewport", () => {
    document.body.innerHTML = `
      <article data-testid="tweet" id="old">
        <a href="/oldauthor">Old Author</a>
        <div data-testid="tweetText">This old offscreen post should not be scanned anymore.</div>
        <a href="/oldauthor/status/111111111">time</a>
      </article>
      <article data-testid="tweet" id="current">
        <a href="/currentauthor">Current Author</a>
        <div data-testid="tweetText">This current viewport post should be the one scored.</div>
        <a href="/currentauthor/status/222222222">time</a>
      </article>
    `;
    vi.spyOn(document.getElementById("old")!, "getBoundingClientRect").mockReturnValue(
      createRect({ top: -400, bottom: -320 })
    );
    vi.spyOn(document.getElementById("current")!, "getBoundingClientRect").mockReturnValue(
      createRect({ top: 120, bottom: 220 })
    );

    const posts = extractVisiblePosts(document);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "222222222",
      author: "currentauthor",
      text: "This current viewport post should be the one scored."
    });
  });

  it("finds and writes to a composer without submitting", () => {
    document.body.innerHTML = `<div role="textbox" contenteditable="true">Old draft</div>`;
    const composer = findComposers(document)[0]!;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false)
    });

    insertTextIntoComposer(composer, "Draft text");

    expect(composer.textContent).toBe("Draft text");
  });

  it("places the helper action beside the native inline submit button", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div><div data-testid="tweetTextarea_0" contenteditable="true"></div></div>
        <div data-testid="toolBar"><div class="submit-slot"><button data-testid="tweetButtonInline">Post</button></div></div>
      </article>
    `;
    const composer = findComposers(document)[0]!;
    const submit = document.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]')!;

    expect(getComposerActionPlacement(composer)).toEqual({ host: submit.parentElement?.parentElement, before: submit.parentElement });
  });

  it("finds the action row for the home composer without a dialog or article wrapper", () => {
    document.body.innerHTML = `
      <main>
        <section class="home-composer">
          <div class="editor"><div data-testid="tweetTextarea_0" contenteditable="true"></div></div>
          <div class="actions"><div class="submit-slot"><button data-testid="tweetButtonInline">Post</button></div></div>
        </section>
      </main>
    `;
    const composer = findComposers(document)[0]!;
    const submit = document.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]')!;

    expect(getComposerActionPlacement(composer)).toEqual({ host: submit.parentElement?.parentElement, before: submit.parentElement });
  });

  it("extracts the source post for a reply modal composer", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <a href="/vedantdotrpm">Vedant</a>
        <div data-testid="tweetText">imagine spending your entire college life on just leetcode maxxing</div>
        <a href="/vedantdotrpm/status/987654321">3h</a>
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
      </div>
    `;
    const composer = findComposers(document)[0]!;

    const sourcePost = getNearestSourcePost(composer);

    expect(sourcePost).toMatchObject({
      id: "987654321",
      author: "vedantdotrpm",
      text: "imagine spending your entire college life on just leetcode maxxing"
    });
  });

  it("does not merge multiple posts when extracting a reply modal source post", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <a href="/firstauthor">First Author</a>
        <div data-testid="tweetText">This is an older post that should not be mixed into the reply context.</div>
        <a href="/firstauthor/status/111111111">4h</a>
        <a href="/targetauthor">Target Author</a>
        <div data-testid="tweetText">This is the exact post the open composer is replying to.</div>
        <a href="/targetauthor/status/222222222">3h</a>
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
      </div>
    `;
    const composer = findComposers(document)[0]!;

    const sourcePost = getNearestSourcePost(composer);

    expect(sourcePost).toMatchObject({
      id: "222222222",
      author: "targetauthor",
      text: "This is the exact post the open composer is replying to."
    });
    expect(sourcePost?.text).not.toContain("older post");
  });

  it("does not merge quoted or nested tweet text from an article source post", () => {
    document.body.innerHTML = `
      <article data-testid="tweet">
        <a href="/sourceauthor">Source Author</a>
        <div data-testid="tweetText">This is the source post that should drive the reply.</div>
        <a href="/sourceauthor/status/333333333">2h</a>
        <div>
          <a href="/quotedauthor">Quoted Author</a>
          <div data-testid="tweetText">This quoted post should not be mixed into the source post.</div>
          <a href="/quotedauthor/status/444444444">1h</a>
        </div>
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
      </article>
    `;
    const composer = findComposers(document)[0]!;

    const sourcePost = getNearestSourcePost(composer);

    expect(sourcePost).toMatchObject({
      id: "333333333",
      author: "sourceauthor",
      text: "This is the source post that should drive the reply."
    });
    expect(sourcePost?.text).not.toContain("quoted post");
  });

  it("keeps an article's main post as target and its nested quote as quoted context", () => {
    document.body.innerHTML = `<article data-testid="tweet"><a href="/main">Main</a><div data-testid="tweetText">Main source post</div><a href="/main/status/1">t</a><a href="/quote">Quote</a><div data-testid="tweetText">Quoted post details</div><a href="/quote/status/2">t</a><div role="textbox" contenteditable="true"></div><button data-testid="tweetButtonInline">Reply</button></article>`;
    const context = getComposerContext(document.querySelector<HTMLElement>('[role="textbox"]')!);
    expect(context.kind).toBe("reply");
    expect(context.target?.text).toBe("Main source post");
    expect(context.quoted?.text).toBe("Quoted post details");
  });

  it("counts quote composers as posts even when a source tweet is visible", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
        <button data-testid="tweetButton">Post</button>
        <a href="/quoted">Quoted</a>
        <div data-testid="tweetText">Quoted source that should not force a reply count</div>
        <a href="/quoted/status/9">1h</a>
      </div>
    `;
    const composer = document.querySelector<HTMLElement>('[role="textbox"]')!;
    const quoted = document.querySelector<HTMLElement>('[data-testid="tweetText"]')!;
    composer.getBoundingClientRect = () => createRect({ top: 40, bottom: 80 });
    quoted.getBoundingClientRect = () => createRect({ top: 100, bottom: 140 });
    const context = getComposerContext(composer);
    expect(context.kind).toBe("post");
    expect(context.target?.text).toContain("Quoted source");
  });

  it("classifies reply composers from the Reply button label", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <a href="/author">Author</a>
        <div data-testid="tweetText">Source asking a question</div>
        <a href="/author/status/42">2h</a>
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
        <button data-testid="tweetButton">Reply</button>
      </div>
    `;
    const context = getComposerContext(document.querySelector<HTMLElement>('[role="textbox"]')!);
    expect(context.kind).toBe("reply");
    expect(context.target?.id).toBe("42");
  });

  it("treats Post-labeled reply composers with a source above as replies", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <a href="/author">Author</a>
        <div data-testid="tweetText">Source asking a question</div>
        <a href="/author/status/42">2h</a>
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>
        <button data-testid="tweetButton">Post</button>
      </div>
    `;
    const composer = document.querySelector<HTMLElement>('[role="textbox"]')!;
    const source = document.querySelector<HTMLElement>('[data-testid="tweetText"]')!;
    source.getBoundingClientRect = () => createRect({ top: 10, bottom: 40 });
    composer.getBoundingClientRect = () => createRect({ top: 60, bottom: 100 });
    const context = getComposerContext(composer);
    expect(context.kind).toBe("reply");
    expect(context.target?.id).toBe("42");
  });
});

function createRect(values: Pick<DOMRect, "top" | "bottom"> & Partial<DOMRect>): DOMRect {
  return {
    x: values.left ?? 0,
    y: values.top,
    width: values.width ?? 300,
    height: values.height ?? values.bottom - values.top,
    top: values.top,
    right: values.right ?? 300,
    bottom: values.bottom,
    left: values.left ?? 0,
    toJSON: () => ({})
  };
}
