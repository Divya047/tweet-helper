import type { VisiblePost } from "@tweet-helper/shared";
import type { ComposerContext, PostContext } from "./contracts.js";

const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"], article';
const COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"][contenteditable="true"], [role="textbox"][contenteditable="true"]';
const DIALOG_SELECTOR = '[role="dialog"]';
const SHOW_MORE_SELECTOR = '[data-testid="tweet-text-show-more-link"], button, [role="button"]';

export async function expandTruncatedPostText(root: ParentNode = document, visibleOnly = false): Promise<number> {
  const candidates = [...root.querySelectorAll<HTMLElement>(SHOW_MORE_SELECTOR)].filter((element) => {
    const label = normalizeElementText(element).toLowerCase();
    if (element.getAttribute("data-testid") !== "tweet-text-show-more-link" && label !== "show more") return false;
    const container = element.closest<HTMLElement>(`${TWEET_ARTICLE_SELECTOR}, ${DIALOG_SELECTOR}`);
    if (!container) return false;
    return !visibleOnly || container.matches(DIALOG_SELECTOR) || isInViewport(container);
  });

  for (const candidate of candidates) candidate.click();
  // X updates tweetText asynchronously after the native click handler runs.
  if (candidates.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  return candidates.length;
}

export function extractVisiblePosts(root: ParentNode = document): VisiblePost[] {
  const articles = [...root.querySelectorAll<HTMLElement>(TWEET_ARTICLE_SELECTOR)]
    .filter((article) => isInViewport(article))
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
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

function isInViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return false;
  }

  return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
}

export function findComposers(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)];
}

export function getComposerActionPlacement(composer: HTMLElement): { host: HTMLElement; before?: HTMLElement } {
  const submitSelector = '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
  let ancestor = composer.parentElement;

  while (ancestor && ancestor !== document.body) {
    const submit = ancestor.querySelector<HTMLElement>(submitSelector);
    const submitSlot = submit?.parentElement;
    if (submitSlot?.parentElement) return { host: submitSlot.parentElement, before: submitSlot };
    ancestor = ancestor.parentElement;
  }
  return { host: composer.parentElement ?? composer };
}

export function isComposerElement(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.matches(COMPOSER_SELECTOR);
}

export function getFocusedComposer(root: Document = document): HTMLElement | undefined {
  const active = root.activeElement;
  if (isComposerElement(active)) {
    return active;
  }
  return findComposers(root)[0];
}

export function getComposerText(composer: HTMLElement): string {
  return (composer.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function insertTextIntoComposer(composer: HTMLElement, text: string): boolean {
  composer.focus();
  selectComposerContents(composer);

  if (dispatchPaste(composer, text)) {
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  selectComposerContents(composer);
  const success = document.execCommand?.("insertText", false, text) ?? false;
  if (!success) {
    composer.replaceChildren(document.createTextNode(text));
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function selectComposerContents(composer: HTMLElement): void {
  const selection = document.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function dispatchPaste(composer: HTMLElement, text: string): boolean {
  if (typeof ClipboardEvent === "undefined" || typeof DataTransfer === "undefined") {
    return false;
  }

  const before = getComposerText(composer);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData
  });
  const wasNotCanceled = composer.dispatchEvent(event);
  const after = getComposerText(composer);
  return !wasNotCanceled || after !== before;
}

export function getNearestSourcePost(composer: HTMLElement): PostContext | undefined {
  const article = composer.closest<HTMLElement>(TWEET_ARTICLE_SELECTOR);
  if (article) {
    return sourcePostFromContainer(article, getTweetTextNodes(article)[0]);
  }

  const dialog = composer.closest<HTMLElement>(DIALOG_SELECTOR);
  if (!dialog) {
    return undefined;
  }

  const sourceTextNode = findSourceTweetText(dialog, composer);
  if (!sourceTextNode) {
    return undefined;
  }

  return sourcePostFromContainer(dialog, sourceTextNode);
}

function sourcePostFromContainer(container: HTMLElement, textNode?: HTMLElement): PostContext | undefined {
  const text = textNode ? normalizeElementText(textNode) : extractPostText(container);
  if (!text) {
    return undefined;
  }
  const url = extractStatusUrl(container, textNode);
  const id = extractStatusId(url);
  const author = extractAuthor(container, textNode);
  return {
    text,
    ...(id ? { id } : {}),
    ...(author ? { author } : {}),
    ...(url ? { url } : {})
  };
}

export function getComposerContext(composer: HTMLElement): ComposerContext {
  const dialog = composer.closest<HTMLElement>(DIALOG_SELECTOR);
  const article = composer.closest<HTMLElement>(TWEET_ARTICLE_SELECTOR);
  const container = dialog ?? article;
  const nodes = container ? getTweetTextNodes(container).filter((node) => !composer.contains(node)) : [];
  const posts = nodes.map((node) => sourcePostFromContainer(container!, node)).filter((post): post is PostContext => !!post);
  const target = article ? posts[0] : posts.at(-1);
  const parent = !article && posts.length > 1 ? posts.at(-2) : undefined;
  const quoted = article && posts.length > 1 ? posts[1] : undefined;
  return {
    kind: target ? "reply" : "post",
    currentText: getComposerText(composer),
    ...(target ? { target } : {}),
    ...(parent && parent.id !== target?.id ? { parent } : {}),
    ...(quoted && quoted.id !== target?.id ? { quoted } : {})
  };
}

export function isEmptyNewPost(composer: HTMLElement): boolean {
  return getComposerContext(composer).kind === "post" && !getComposerText(composer);
}

function findSourceTweetText(container: HTMLElement, composer: HTMLElement): HTMLElement | undefined {
  const tweetTextNodes = getTweetTextNodes(container)
    .filter((node) => !composer.contains(node))
    .filter((node) => node.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING);

  if (tweetTextNodes.length === 0) {
    return undefined;
  }

  const composerRect = composer.getBoundingClientRect();
  const visuallyRanked = tweetTextNodes
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.bottom <= composerRect.top)
    .sort((left, right) => right.rect.bottom - left.rect.bottom);

  return visuallyRanked[0]?.node ?? tweetTextNodes.at(-1);
}

export function extractPostText(article: HTMLElement): string {
  const textNode = getTweetTextNodes(article)[0];
  const text = textNode ? normalizeElementText(textNode) : article.innerText || article.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

function getTweetTextNodes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TWEET_TEXT_SELECTOR)].filter((node) => normalizeElementText(node));
}

function normalizeElementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function extractStatusUrl(container: HTMLElement, nearNode?: HTMLElement): string | undefined {
  const anchors = [...container.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].filter((link) =>
    /\/status\/\d+/.test(link.href)
  );
  const anchor = nearNode
    ? findClosestElementAfter(anchors, nearNode) ?? findClosestElementBefore(anchors, nearNode) ?? anchors[0]
    : anchors[0];
  return anchor?.href;
}

function extractStatusId(url: string | undefined): string | undefined {
  return url?.match(/\/status\/(\d+)/)?.[1];
}

function extractAuthor(container: HTMLElement, nearNode?: HTMLElement): string | undefined {
  const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/"], a[href^="https://x.com/"]')].filter(
    (anchor) => {
      const href = anchor.getAttribute("href") ?? "";
      return /^\/[A-Za-z0-9_]+$/.test(href) || /^https:\/\/x\.com\/[A-Za-z0-9_]+$/.test(href);
    }
  );
  const link = nearNode ? findClosestElementBefore(links, nearNode) ?? links[0] : links[0];
  const href = link?.getAttribute("href") ?? "";
  const match = href.match(/(?:x\.com)?\/([A-Za-z0-9_]+)/);
  return match?.[1];
}

function findClosestElementBefore<T extends Element>(elements: T[], target: Element): T | undefined {
  return elements.filter((element) => element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
}

function findClosestElementAfter<T extends Element>(elements: T[], target: Element): T | undefined {
  return elements.find((element) => target.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
}
