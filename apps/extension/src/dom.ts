import type { SourcePost, VisiblePost } from "@tweet-helper/shared";

const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"], article';
const COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"][contenteditable="true"], [role="textbox"][contenteditable="true"]';

export function extractVisiblePosts(root: ParentNode = document): VisiblePost[] {
  const articles = [...root.querySelectorAll<HTMLElement>(TWEET_ARTICLE_SELECTOR)];
  const posts: VisiblePost[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    const text = extractPostText(article);
    if (!text || text.length < 20) {
      continue;
    }
    const url = extractStatusUrl(article);
    const id = extractStatusId(url) ?? `visible-${posts.length}`;
    if (seen.has(id)) {
      continue;
    }
    const author = extractAuthor(article);
    seen.add(id);
    posts.push({
      id,
      text,
      viewportIndex: posts.length,
      ...(author ? { author } : {}),
      ...(url ? { url } : {})
    });
  }

  return posts.slice(0, 20);
}

export function findComposers(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)];
}

export function getFocusedComposer(root: Document = document): HTMLElement | undefined {
  const active = root.activeElement;
  if (active instanceof HTMLElement && active.matches(COMPOSER_SELECTOR)) {
    return active;
  }
  return findComposers(root)[0];
}

export function getComposerText(composer: HTMLElement): string {
  return (composer.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function insertTextIntoComposer(composer: HTMLElement, text: string): boolean {
  composer.focus();
  const selection = document.getSelection();
  if (selection && composer.contains(selection.anchorNode)) {
    selection.deleteFromDocument();
  }

  const success = document.execCommand?.("insertText", false, text) ?? false;
  if (!success) {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function getNearestSourcePost(composer: HTMLElement): SourcePost | undefined {
  const article = composer.closest<HTMLElement>(TWEET_ARTICLE_SELECTOR);
  if (!article) {
    return undefined;
  }
  const text = extractPostText(article);
  if (!text) {
    return undefined;
  }
  const url = extractStatusUrl(article);
  const id = extractStatusId(url);
  const author = extractAuthor(article);
  return {
    text,
    ...(id ? { id } : {}),
    ...(author ? { author } : {}),
    ...(url ? { url } : {})
  };
}

export function extractPostText(article: HTMLElement): string {
  const tweetTextNodes = [...article.querySelectorAll<HTMLElement>(TWEET_TEXT_SELECTOR)];
  const text =
    tweetTextNodes.length > 0
      ? tweetTextNodes.map((node) => node.innerText || node.textContent || "").join("\n")
      : article.innerText || article.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

function extractStatusUrl(article: HTMLElement): string | undefined {
  const anchor = [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].find((link) =>
    /\/status\/\d+/.test(link.href)
  );
  return anchor?.href;
}

function extractStatusId(url: string | undefined): string | undefined {
  return url?.match(/\/status\/(\d+)/)?.[1];
}

function extractAuthor(article: HTMLElement): string | undefined {
  const link = [...article.querySelectorAll<HTMLAnchorElement>('a[href^="/"], a[href^="https://x.com/"]')].find(
    (anchor) => {
      const href = anchor.getAttribute("href") ?? "";
      return /^\/[A-Za-z0-9_]+$/.test(href) || /^https:\/\/x\.com\/[A-Za-z0-9_]+$/.test(href);
    }
  );
  const href = link?.getAttribute("href") ?? "";
  const match = href.match(/(?:x\.com)?\/([A-Za-z0-9_]+)/);
  return match?.[1];
}
