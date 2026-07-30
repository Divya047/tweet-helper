// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compatibleQueueItem, contextualAction, publishContextForSubmit, queueInsertionIssue, replaceWithUndo } from "../src/content.js";
import { getComposerContext } from "../src/dom.js";
import { PublishTracker } from "../src/publish.js";
import { activityFromEvents, appendEvent, loadState, saveState } from "../src/state.js";

beforeEach(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn() }, storage: { local: { get: vi.fn(async (key: string) => ({ [key]: data[key] })), set: vi.fn(async (value: Record<string, unknown>) => Object.assign(data, value)) } } });
  document.body.innerHTML = "";
});

describe("contextual composer action", () => {
  it("chooses the single action from context and queue state", () => {
    expect(contextualAction({ kind: "reply", currentText: "" }, false)).toBe("Draft reply");
    expect(contextualAction({ kind: "post", currentText: "rough" }, false)).toBe("Improve");
    expect(contextualAction({ kind: "post", currentText: "" }, false)).toBe("Open brief");
    expect(contextualAction({ kind: "reply", currentText: "" }, true)).toBe("Insert next");
  });
  it("only offers queued insertion when the draft is compatible with the live composer", () => {
    const queuedReply = {
      id: "q1",
      draft: { id: "d1", text: "reply" },
      context: { kind: "reply" as const, currentText: "", target: { id: "1", text: "source" } },
      createdAt: 1
    };
    expect(queueInsertionIssue(queuedReply, { kind: "post", currentText: "" })).toContain("reply draft");
    expect(queueInsertionIssue(queuedReply, {
      kind: "reply",
      currentText: "",
      target: { id: "2", text: "another source" }
    })).toContain("different source post");
    expect(queueInsertionIssue(queuedReply, {
      kind: "reply",
      currentText: "",
      target: { id: "1", text: "source" }
    })).toBeUndefined();
    expect(contextualAction({ kind: "post", currentText: "" }, false)).toBe("Open brief");
  });
  it("finds the queue item for the open source even when a different draft is active", () => {
    const queue = [
      {
        id: "active-post",
        draft: { id: "d1", text: "standalone post" },
        context: { kind: "post" as const, currentText: "" },
        createdAt: 1
      },
      {
        id: "matching-reply",
        draft: { id: "d2", text: "matching reply" },
        context: { kind: "reply" as const, currentText: "", target: { id: "42", text: "source" } },
        createdAt: 2
      }
    ];
    expect(compatibleQueueItem(queue, "active-post", {
      kind: "reply",
      currentText: "",
      target: { id: "42", text: "source" }
    })?.id).toBe("matching-reply");
  });
  it("replaces in one call and supports immediate undo without submitting", () => {
    document.body.innerHTML = `<div role="textbox" contenteditable="true">rough</div><button data-testid="tweetButton">Post</button>`;
    const composer = document.querySelector<HTMLElement>("[role=textbox]")!;
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    const submitted = vi.fn(); document.querySelector("button")!.addEventListener("click", submitted);
    const undo = replaceWithUndo(composer, "improved"); expect(composer.textContent).toBe("improved"); expect(submitted).not.toHaveBeenCalled();
    undo(); expect(composer.textContent).toBe("rough");
  });
});

describe("structured X context", () => {
  it("keeps target, parent, and quoted text separate", () => {
    document.body.innerHTML = `<div role="dialog"><a href="/parent">p</a><div data-testid="tweetText">Parent text</div><a href="/parent/status/1">t</a><a href="/target">t</a><div data-testid="tweetText">Target text</div><a href="/target/status/2">t</a><div role="textbox" contenteditable="true"></div></div>`;
    const context = getComposerContext(document.querySelector<HTMLElement>("[role=textbox]")!);
    expect(context.target?.text).toBe("Target text"); expect(context.parent?.text).toBe("Parent text"); expect(context.target?.id).not.toBe(context.parent?.id);
  });
});

describe("publish evidence and persistence", () => {
  it("records only a confirmed attempt and carries external ids", () => {
    const tracker = new PublishTracker(); expect(tracker.confirm("1")).toBeUndefined();
    tracker.begin({ context: { kind: "post", currentText: "done" }, finalText: "done", startedAt: 1 });
    expect(tracker.confirm("123")).toMatchObject({ kind: "published", externalId: "123", finalText: "done" });
    expect(tracker.confirm("123")).toBeUndefined();
  });
  it("never records cancelled attempts", () => { const tracker = new PublishTracker(); tracker.begin({ context: { kind: "reply", currentText: "x" }, finalText: "x", startedAt: 1 }); tracker.cancel(); expect(tracker.confirm()).toBeUndefined(); });
  it("persists sessions, queue, and deduplicates stable client event ids", async () => {
    const state = await loadState(); state.queue.push({ id: "q1", draft: { id: "d1", text: "draft" }, context: { kind: "post", currentText: "" }, createdAt: 1 }); await saveState(state);
    const event = { clientEventId: "stable-1", kind: "insert" as const, occurredAt: new Date().toISOString(), finalText: "draft", context: { kind: "post" as const, currentText: "draft" } };
    await appendEvent(event); await appendEvent(event); const restored = await loadState(); expect(restored.sessionId).toBe(state.sessionId); expect(restored.queue).toHaveLength(1); expect(restored.events).toHaveLength(1); expect(restored.activity.posts).toBe(1);
  });
  it("counts helper insertions by stored kind and ignores native publish events", () => {
    const today = new Date().toISOString();
    const rebuilt = activityFromEvents([
      { clientEventId: "p1", kind: "insert", occurredAt: today, finalText: "original", context: { kind: "post", currentText: "original" } },
      { clientEventId: "q1", kind: "insert", occurredAt: today, finalText: "quote take", context: { kind: "post", currentText: "quote take", target: { text: "quoted source", id: "9" } } },
      { clientEventId: "r1", kind: "insert", occurredAt: today, finalText: "another", context: { kind: "reply", currentText: "another", target: { text: "source 2" } } },
      { clientEventId: "published", kind: "published", occurredAt: today, finalText: "ignored", context: { kind: "reply", currentText: "ignored" } }
    ]);
    expect(rebuilt.posts).toBe(2);
    expect(rebuilt.replies).toBe(1);
  });
  it("keeps the inserted draft kind after the composer text is rewritten", () => {
    const live = { kind: "post" as const, currentText: "@author edited reply" };
    const last = { context: { kind: "reply" as const, currentText: "draft reply", target: { text: "source", id: "1" } } };
    expect(publishContextForSubmit("@author edited reply", last, live)).toMatchObject({
      kind: "reply",
      currentText: "@author edited reply",
      target: { id: "1" }
    });
    expect(publishContextForSubmit("solo post", undefined, { kind: "post", currentText: "solo post" }).kind).toBe("post");
  });
});
