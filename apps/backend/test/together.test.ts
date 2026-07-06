import { afterEach, describe, expect, it, vi } from "vitest";
import { createTogetherClient, draftResponseSchema, type JsonCompletionRequest } from "../src/together.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Together client", () => {
  it("retries once when the model returns malformed JSON", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse('{"suggestions":[{"text":"unfinished'))
      .mockResolvedValueOnce(
        jsonResponse(
          JSON.stringify({
            suggestions: [{ text: "Fixed JSON.", rationale: "Repair worked.", confidence: 0.8 }]
          })
        )
      );
    globalThis.fetch = fetchMock;

    const result = await createTogetherClient("test-key").completeJson(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.value).toEqual({
      suggestions: [{ text: "Fixed JSON.", rationale: "Repair worked.", confidence: 0.8 }]
    });
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { max_tokens: number; temperature: number };
    expect(repairBody.max_tokens).toBe(2000);
    expect(repairBody.temperature).toBe(0);
  });

  it("does not retry successful JSON responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        JSON.stringify({
          suggestions: [{ text: "Valid JSON.", rationale: "No repair needed.", confidence: 0.9 }]
        })
      )
    );
    globalThis.fetch = fetchMock;

    await createTogetherClient("test-key").completeJson(request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

function jsonResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    })
  } as Response;
}
