import type { ClientEvent, ComposerContext } from "./contracts.js";
import { stableId } from "./contracts.js";

export interface PublishAttempt { context: ComposerContext; finalText: string; startedAt: number; suggestionId?: string }

export class PublishTracker {
  private attempt: PublishAttempt | undefined;
  begin(attempt: PublishAttempt): void { this.attempt = attempt; }
  cancel(): void { this.attempt = undefined; }
  confirm(externalId?: string): ClientEvent | undefined {
    if (!this.attempt) return undefined;
    const attempt = this.attempt;
    this.attempt = undefined;
    return {
      clientEventId: stableId("published"), kind: "published", occurredAt: new Date().toISOString(),
      ...(attempt.suggestionId ? { suggestionId: attempt.suggestionId } : {}),
      ...(externalId ? { externalId } : {}), finalText: attempt.finalText, context: attempt.context
    };
  }
  get pending(): boolean { return !!this.attempt; }
}

export function statusIdFromUrl(url: string): string | undefined { return url.match(/\/status\/(\d+)/)?.[1]; }
export function hasPublishSuccessEvidence(root: ParentNode = document): boolean {
  return !!root.querySelector('[data-testid="toast"] a[href*="/status/"]');
}
