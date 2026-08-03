import { describe, expect, it, vi } from "vitest";
import {
  createCodexClient,
  draftResponseSchema,
  type CodexInvocation,
  type JsonCompletionRequest
} from "../src/codex.js";

describe("Codex CLI client", () => {
  it("retries once when the model returns malformed JSON", async () => {
    const run = vi
      .fn<(invocation: CodexInvocation) => Promise<string>>()
      .mockResolvedValueOnce('{"suggestions":[{"text":"unfinished')
      .mockResolvedValueOnce(JSON.stringify({
        suggestions: [{ text: "Fixed JSON.", rationale: "Repair worked.", confidence: 0.8 }]
      }));

    const result = await createCodexClient({ run }).completeJson(request());

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.value).toEqual({
      suggestions: [{ text: "Fixed JSON.", rationale: "Repair worked.", confidence: 0.8 }]
    });
    expect(run.mock.calls[0]?.[0].schema).toBe(draftResponseSchema);
    expect(run.mock.calls[1]?.[0].prompt).toContain("previous response was not complete valid JSON");
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.costUsd).toBe(0);
  });

  it("does not retry successful JSON responses", async () => {
    const run = vi.fn<(invocation: CodexInvocation) => Promise<string>>().mockResolvedValueOnce(
      JSON.stringify({ suggestions: [{ text: "Valid JSON.", rationale: "No repair needed.", confidence: 0.9 }] })
    );

    await createCodexClient({ run }).completeJson(request());

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("forwards image attachments to the Codex invocation", async () => {
    const run = vi.fn<(invocation: CodexInvocation) => Promise<string>>().mockResolvedValueOnce(
      JSON.stringify({ suggestions: [{ text: "Visual reply.", rationale: "Uses the chart.", confidence: 0.9 }] })
    );
    const imageUrls = ["https://pbs.twimg.com/media/chart.jpg"];

    await createCodexClient({ run }).completeJson({ ...request(), imageUrls });

    expect(run.mock.calls[0]?.[0].imageUrls).toEqual(imageUrls);
  });
});

function request(): JsonCompletionRequest {
  return {
    messages: [{ role: "user", content: "Generate one suggestion." }],
    schemaName: "DraftResponse",
    schema: draftResponseSchema,
    maxTokens: 1000,
    temperature: 0.5
  };
}
