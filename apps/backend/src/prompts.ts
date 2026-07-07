import type { GenerateCommentRequest, GeneratePostRequest, ScoreVisiblePostsRequest } from "@tweet-helper/shared";
import type { WritingExample } from "./db.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildPostMessages(
  request: GeneratePostRequest,
  styleProfileJson: string | undefined,
  examples: WritingExample[]
): ChatMessage[] {
  const mode = request.mode === "cheap" ? "cheap" : "standard";
  const suggestionCount = mode === "cheap" ? 2 : 3;
  return [
    {
      role: "system",
      content: [
        "You write X posts for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Never invent facts, links, metrics, credentials, or personal experiences.",
        "Avoid engagement bait, spam, hashtags unless asked, and generic influencer phrasing.",
        `Do not use the phrase "real flex" unless the user explicitly asks for it.`,
        "Produce multiple distinct options, not minor paraphrases.",
        "For 3 suggestions: make 2 safe/on-brand and 1 exploratory (more creative, unusual structure, or bolder angle) while staying truthful and non-cringe.",
        "For 2 suggestions: make 1 safe/on-brand and 1 exploratory.",
        "Generate options the user can approve manually.",
        mode === "cheap" ? "Be brief. Minimize rationale length." : ""
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "generate_post",
          topic: request.topic,
          goal: request.goal ?? "authentic",
          length: request.length ?? "short",
          instructions: request.instructions ?? "",
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          similarPastWriting: examples.map(formatExample),
          requiredOutput: `Return ${suggestionCount} suggestions with text, rationale, confidence. Ensure one suggestion is explicitly exploratory/different.`
        },
        null,
        2
      )
    }
  ];
}

export function buildCommentMessages(
  request: GenerateCommentRequest,
  styleProfileJson: string | undefined,
  examples: WritingExample[]
): ChatMessage[] {
  const mode = request.mode === "cheap" ? "cheap" : "standard";
  const suggestionCount = mode === "cheap" ? 2 : 3;
  return [
    {
      role: "system",
      content: [
        "You write concise X replies/comments for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Do not harass, dogpile, spam, manipulate engagement, or imply the user read something they did not.",
        "Do not click or submit anything. The user will manually approve any draft.",
        `Avoid overusing catchphrases from the user's past writing. Do not use the phrase "real flex" unless it appears in the source post or the user's instructions.`,
        "Produce multiple distinct options, not minor paraphrases.",
        "For 3 reply suggestions: make 2 safe/on-brand and 1 exploratory (more creative, unusual structure, or bolder angle) while staying respectful and non-spammy.",
        "For 2 reply suggestions: make 1 safe/on-brand and 1 exploratory.",
        mode === "cheap" ? "Be brief. Minimize rationale length." : ""
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "generate_comment",
          sourcePost: request.sourcePost,
          angle: request.angle ?? "",
          instructions: request.instructions ?? "",
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          similarPastWriting: examples.map(formatExample),
          requiredOutput: `Return ${suggestionCount} reply suggestions with text, rationale, confidence. Ensure one suggestion is explicitly exploratory/different.`
        },
        null,
        2
      )
    }
  ];
}

export function buildScoreMessages(
  request: ScoreVisiblePostsRequest,
  styleProfileJson: string | undefined,
  examples: WritingExample[]
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a read-only X reaction opportunity selector.",
        "Rank visible posts for whether the user should react, but do not automate engagement.",
        "Recommend only one of: reply, quote idea, save for later, skip.",
        "Prefer posts where the user can add something useful, authentic, and non-spammy.",
        "Penalize ragebait, low-context posts, repetitive trends, and obvious promotional traps.",
        "Return only valid JSON matching the schema."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "score_visible_posts",
          visiblePosts: request.posts.slice(0, 20),
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          representativePastWriting: examples.map(formatExample).slice(0, 10),
          scoringCriteria: [
            "relevance to user's usual topics",
            "likelihood the user can add a useful reply",
            "tone fit",
            "recency/context clarity",
            "spam/ragebait risk"
          ],
          requiredOutput: "rank each input post with score, recommendation, reason, suggestedAngle, optional draftSeed, risks"
        },
        null,
        2
      )
    }
  ];
}

function formatExample(example: WritingExample): Pick<WritingExample, "kind" | "text" | "createdAt"> {
  return {
    kind: example.kind,
    text: example.text,
    createdAt: example.createdAt
  };
}
