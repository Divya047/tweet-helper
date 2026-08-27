import type { VisiblePost } from "@tweet-helper/shared";
import type { ComposerContext, ComposerKind, PostContext } from "./contracts.js";

const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const TWEET_MEDIA_IMAGE_SELECTOR = '[data-testid="tweetPhoto"] img[src], img[src*="pbs.twimg.com/media/"]';
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

export function findTweetArticle(root: ParentNode, target: Pick<PostContext, "id" | "url" | "text">): HTMLElement | undefined {
  const articles = [...root.querySelectorAll<HTMLElement>(TWEET_ARTICLE_SELECTOR)];
  const statusId = (target.id && /^\d+$/.test(target.id) ? target.id : undefined) ?? extractStatusId(target.url);
  if (statusId) {
    const byId = articles.find((article) => {
      const textNode = getTweetTextNodes(article)[0];
      return extractStatusId(extractStatusUrl(article, textNode)) === statusId;
    });
    if (byId) return byId;
  }
  const needle = target.text?.replace(/\s+/g, " ").trim();
  if (!needle) return undefined;
  return articles.find((article) => extractPostText(article) === needle);
}

export type FeedScrollProgress = {
  posts: number;
  scrolls: number;
  elapsedMs: number;
};

export type CollectFeedPostsOptions = {
  root?: Document | HTMLElement;
  excludeIds?: Iterable<string>;
  maxCandidates?: number;
  maxScrolls?: number;
  pauseMs?: number;
  stagnantLimit?: number;
  scrollStepPercent?: number;
  /** Soft time budget for long trend scans. Checked between scrolls. */
  maxDurationMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: FeedScrollProgress) => void;
  scroll?: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type CollectFeedPostsResult = {
  posts: VisiblePost[];
  scrolls: number;
  elapsedMs: number;
  stoppedReason: "cap" | "stagnant" | "duration" | "aborted";
};

export async function collectFeedPosts(options: CollectFeedPostsOptions = {}): Promise<CollectFeedPostsResult> {
  const root = options.root ?? document;
  const exclude = new Set(options.excludeIds ?? []);
  const maxCandidates = options.maxCandidates ?? 24;
  const maxScrolls = options.maxScrolls ?? 10;
  const pauseMs = options.pauseMs ?? 750;
  const stagnantLimit = options.stagnantLimit ?? 4;
  const maxDurationMs = options.maxDurationMs;
  const signal = options.signal;
  const onProgress = options.onProgress;
  const scrollStepPercent = Math.min(90, Math.max(40, options.scrollStepPercent ?? 65));
  const scroll = options.scroll ?? (() => defaultScrollFeed(scrollStepPercent));
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const collected = new Map<string, VisiblePost>();
  let scrolls = 0;
  let stagnant = 0;
  let stoppedReason: CollectFeedPostsResult["stoppedReason"] = "cap";

  const elapsed = (): number => Math.max(0, now() - startedAt);
  const report = (): void => {
    onProgress?.({ posts: collected.size, scrolls, elapsedMs: elapsed() });
  };
  const timedOut = (): boolean => maxDurationMs !== undefined && elapsed() >= maxDurationMs;
  const aborted = (): boolean => !!signal?.aborted;

  report();
  while (collected.size < maxCandidates && scrolls <= maxScrolls) {
    if (aborted()) {
      stoppedReason = "aborted";
      break;
    }
    if (timedOut()) {
      stoppedReason = "duration";
      break;
    }

    await expandTruncatedPostText(root, true);
    const before = collected.size;
    for (const post of extractVisiblePosts(root)) {
      const key = post.id || post.text;
      if (!key || exclude.has(key) || exclude.has(post.text) || collected.has(key)) continue;
      collected.set(key, { ...post, viewportIndex: collected.size });
      if (collected.size >= maxCandidates) break;
    }
    report();

    if (collected.size >= maxCandidates) {
      stoppedReason = "cap";
      break;
    }
    if (scrolls >= maxScrolls) {
      stoppedReason = "cap";
      break;
    }
    if (collected.size === before) {
      stagnant += 1;
      if (stagnant >= stagnantLimit && scrolls > 0) {
        stoppedReason = "stagnant";
        break;
      }
    } else {
      stagnant = 0;
    }

    if (aborted()) {
      stoppedReason = "aborted";
      break;
    }
    if (timedOut()) {
      stoppedReason = "duration";
      break;
    }

    scroll();
    scrolls += 1;
    report();
    await wait(pauseMs);
  }

  report();
  return { posts: [...collected.values()], scrolls, elapsedMs: elapsed(), stoppedReason };
}

function defaultScrollFeed(scrollStepPercent: number): void {
  const amount = Math.round(Math.max(window.innerHeight * (scrollStepPercent / 100), 300));
  const column = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
  if (column && column.scrollHeight > column.clientHeight + 40) {
    column.scrollBy(0, amount);
    return;
  }
  window.scrollBy(0, amount);
}

export function extractVisiblePosts(root: ParentNode = document): VisiblePost[] {
  const articles = [...root.querySelectorAll<HTMLElement>(TWEET_ARTICLE_SELECTOR)]
    .filter((article) => isInViewport(article))
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
  const posts: VisiblePost[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    const textNode = getTweetTextNodes(article)[0];
    const media = extractPostMedia(article, textNode);
    const text = textNode
      ? normalizeElementText(textNode)
      : media.length
        ? imageOnlyPostText(media)
        : extractPostText(article);
    if ((!text || text.length < 20) && !media.length) {
      continue;
    }
    const url = extractStatusUrl(article, textNode);
    const id = extractStatusId(url) ?? `visible-${posts.length}`;
    if (seen.has(id)) {
      continue;
    }
    const author = extractAuthor(article, textNode);
    seen.add(id);
    posts.push({
      id,
      text,
      viewportIndex: posts.length,
      ...(author ? { author } : {}),
      ...(url ? { url } : {}),
      ...(media.length ? { media } : {})
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
  const composers = findComposers(root);
  return composers.find(isVisibleComposer) ?? composers[0];
}

function isVisibleComposer(composer: HTMLElement): boolean {
  if (composer.hidden || composer.getAttribute("aria-hidden") === "true") return false;
  if (composer.closest('[hidden], [aria-hidden="true"]')) return false;
  const rect = composer.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
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
    return sourcePostFromContainer(dialog);
  }

  return sourcePostFromContainer(dialog, sourceTextNode);
}

function sourcePostFromContainer(container: HTMLElement, textNode?: HTMLElement): PostContext | undefined {
  const media = extractPostMedia(container, textNode);
  const text = textNode
    ? normalizeElementText(textNode)
    : media.length
      ? imageOnlyPostText(media)
      : extractPostText(container);
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
    ...(url ? { url } : {}),
    ...(media.length ? { media } : {})
  };
}

export function getComposerContext(composer: HTMLElement): ComposerContext {
  const dialog = composer.closest<HTMLElement>(DIALOG_SELECTOR);
  const article = composer.closest<HTMLElement>(TWEET_ARTICLE_SELECTOR);
  const container = dialog ?? article;
  const nodes = container ? getTweetTextNodes(container).filter((node) => !composer.contains(node)) : [];
  const posts = nodes.map((node) => sourcePostFromContainer(container!, node)).filter((post): post is PostContext => !!post);
  if (container && posts.length === 0) {
    const mediaOnlyPost = sourcePostFromContainer(container);
    if (mediaOnlyPost) posts.push(mediaOnlyPost);
  }
  const target = article ? posts[0] : posts.at(-1);
  const parent = !article && posts.length > 1 ? posts.at(-2) : undefined;
  const quoted = article && posts.length > 1 ? posts[1] : undefined;
  const kind = inferComposerKind(composer, !!target);
  return {
    kind,
    currentText: getComposerText(composer),
    // Keep source/quoted text for drafting even when soft-goal kind is "post" (quotes).
    ...(target ? { target } : {}),
    ...(parent && parent.id !== target?.id ? { parent } : {}),
    ...(quoted && quoted.id !== target?.id ? { quoted } : {})
  };
}

/** Infer post vs reply for drafting and insertion context. X often labels reply submit as "Post". */
export function inferComposerKind(composer: HTMLElement, hasTarget: boolean): ComposerKind {
  const scope =
    composer.closest<HTMLElement>(`${DIALOG_SELECTOR}, ${TWEET_ARTICLE_SELECTOR}`)
    ?? composer.closest<HTMLElement>('[data-testid="toolBar"]')?.parentElement
    ?? composer.parentElement
    ?? composer;
  const buttons = [
    ...scope.querySelectorAll<HTMLElement>('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
  ];
  const nearby = buttons.find((button) => !composer.contains(button)) ?? buttons[0];
  const label = nearby ? normalizeElementText(nearby).toLowerCase() : "";
  if (/\breply\b/.test(label)) return "reply";
  if (/\bquote\b/.test(label)) return "post";
  const replyMarker = scope.querySelector(
    '[data-testid="reply"], [aria-label*="Replying to" i], [aria-label*="Reply to" i]'
  );
  if (replyMarker) return "reply";
  if (!hasTarget) return "post";
  // Source tweet above the composer ⇒ reply. Attachment below (quote) ⇒ post.
  // Do not trust a bare "Post" label — X uses it for replies too.
  return hasTweetTextAboveComposer(composer, scope) ? "reply" : "post";
}

function hasTweetTextAboveComposer(composer: HTMLElement, scope: HTMLElement): boolean {
  const composerTop = composer.getBoundingClientRect().top;
  return getTweetTextNodes(scope)
    .filter((node) => !composer.contains(node))
    .some((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom <= composerTop + 4;
    });
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

function extractPostMedia(container: HTMLElement, textNode?: HTMLElement): Array<{ type: "image"; url: string; altText?: string }> {
  const textNodes = getTweetTextNodes(container);
  const images = [...container.querySelectorAll<HTMLImageElement>(TWEET_MEDIA_IMAGE_SELECTOR)];
  const assigned = textNode
    ? images.filter((candidate) => nearestPrecedingTextNode(candidate, textNodes) === textNode)
    : images;
  const seen = new Set<string>();
  return assigned.flatMap((candidate) => {
    const url = normalizeXMediaUrl(candidate.currentSrc || candidate.src);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const altText = candidate.alt?.trim();
    return [{ type: "image" as const, url, ...(altText ? { altText } : {}) }];
  });
}

function nearestPrecedingTextNode(image: HTMLImageElement, textNodes: HTMLElement[]): HTMLElement | undefined {
  let nearest: HTMLElement | undefined;
  for (const node of textNodes) {
    if (node === image || !(node.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    nearest = node;
  }
  return nearest;
}

function normalizeXMediaUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return undefined;
    if (url.searchParams.has("name")) url.searchParams.set("name", "large");
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageOnlyPostText(media: Array<{ altText?: string }>): string {
  const usefulAlt = media.map((item) => item.altText?.trim()).find((alt) => alt && !/^image$/i.test(alt));
  return usefulAlt ? `Image post: ${usefulAlt}` : "Image post with no written caption.";
}

function normalizeElementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function extractStatusUrl(container: HTMLElement, nearNode?: HTMLElement): string | undefined {
  const anchors = [...container.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].filter((link) =>
    /\/status\/\d+/.test(link.href)
  );
  const author = extractAuthor(container, nearNode ?? getTweetTextNodes(container)[0]);
  const authorAnchors = author
    ? anchors.filter((anchor) => statusAuthor(anchor.href)?.toLowerCase() === author.toLowerCase())
    : [];
  const candidates = authorAnchors.length ? authorAnchors : anchors;
  const anchor = nearNode
    ? findClosestElementBefore(candidates, nearNode) ?? findClosestElementAfter(candidates, nearNode) ?? candidates[0]
    : candidates[0];
  return anchor?.href;
}

function extractStatusId(url: string | undefined): string | undefined {
  return url?.match(/\/status\/(\d+)/)?.[1];
}

function statusAuthor(url: string): string | undefined {
  return url.match(/(?:x\.com|twitter\.com)?\/([A-Za-z0-9_]+)\/status\/\d+/i)?.[1];
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
