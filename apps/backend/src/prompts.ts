import type {
  GenerateCommentRequest,
  GeneratePostRequest,
  GenerateRewriteRequest,
  ScoreVisiblePostsRequest
} from "@tweet-helper/shared";
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
  const suggestionCount = mode === "cheap" ? 2 : 5;
  return [
    {
      role: "system",
      content: [
        "You write X posts for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Never invent facts, links, metrics, credentials, or personal experiences.",
        "Avoid engagement bait, spam, hashtags unless asked, and generic influencer phrasing.",
        "Optimize for earned attention from peer founders and builders: useful enough to save, specific enough to trust, or thoughtful enough to reply to.",
        "Prefer concrete shipping lessons, technical tradeoffs, experiments, and informed founder POV over vague inspiration.",
        "Write so builders who share the user's niche would want to follow or reply — peer recognition over vanity reach.",
        "Each option must deliver value through one primary lane: a build-in-public lesson, practical teaching, or an informed point of view.",
        "Use a clear first line, develop one idea, and leave the reader with a concrete takeaway.",
        "If a question is used, give the reader a useful observation first; never publish a naked engagement question.",
        "Use only details supplied by the user. If a strong example would require an invented experience or metric, choose a different structure.",
        "Prefer a sharp first line, a specific point of view, and concrete language over bland summary.",
        "Bolder does not mean louder: avoid fake certainty, dunking, vague hot takes, and empty contrarianism.",
        `Do not use the phrase "real flex" unless the user explicitly asks for it.`,
        "Do not copy or closely paraphrase past tweets; use similarPastWriting only as voice and style reference.",
        "Produce multiple distinct options, not minor paraphrases.",
        "For 5 suggestions: make the first the single strongest recommendation and the next four distinct Explore strategies (specific, contrarian, story-led, and concise/practical).",
        "For 2 suggestions: make 1 safe/on-brand and 1 exploratory with a stronger hook.",
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
          targetAudience: request.audience ?? "the user's intended professional audience",
          contentPillar: request.contentPillar ?? "choose the strongest fit",
          desiredOutcome: request.desiredOutcome ?? "earn relevant follows",
          instructions: request.instructions ?? "",
          regenerationSeed: request.regenerationSeed ?? "initial",
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
  examples: WritingExample[],
  pairedExamples: Array<{sourceText:string;replyText:string}> = []
): ChatMessage[] {
  const mode = request.mode === "cheap" ? "cheap" : "standard";
  const suggestionCount = mode === "cheap" ? 2 : 5;
  const desiredOutcome = request.desiredOutcome ?? "earn relevant follows";
  return [
    {
      role: "system",
      content: [
        "You write concise X replies/comments for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Do not harass, dogpile, spam, manipulate engagement, or imply the user read something they did not.",
        "Do not click or submit anything. The user will manually approve any draft.",
        "Prefer replies that signal peer founder/builder expertise: an implementation detail, counterexample, constraint, tradeoff, or practical caveat.",
        "Write a complete thought that is useful even when read on its own, while still responding directly to the source post.",
        "When possible, contribute an implementation detail, counterexample, implication, or well-reasoned question that the source author did not already state.",
        "Do not ask a question merely to get a response; earn the question with a useful premise first.",
        "Avoid generic agreement, applause, reply-guy energy, and comments that merely restate the source post.",
        "When the desired outcome is earning relevant follows or starting a useful conversation, make the reply strong enough that the author or their peer audience would want to know the user.",
        `Avoid overusing catchphrases from the user's past writing. Do not use the phrase "real flex" unless it appears in the source post or the user's instructions.`,
        "Do not copy or closely paraphrase past tweets; use similarPastWriting only as voice and style reference.",
        "Produce multiple distinct options, not minor paraphrases.",
        "For 5 reply suggestions: make the first the single strongest recommendation and the next four distinct Explore strategies (specific, constructive disagreement, personal/preference question, and concise/practical).",
        "For 2 reply suggestions: make 1 safe/on-brand and 1 exploratory with a sharper angle.",
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
          targetAudience: request.audience ?? "the user's intended professional audience",
          contentPillar: request.contentPillar ?? "choose the strongest fit",
          desiredOutcome,
          instructions: request.instructions ?? "",
          regenerationSeed: request.regenerationSeed ?? "initial",
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          similarPastWriting: examples.map(formatExample),
          learnedSourceReplyPairs: pairedExamples,
          requiredOutput: `Return ${suggestionCount} reply suggestions with text, rationale, confidence. Ensure one suggestion is explicitly exploratory/different.`
        },
        null,
        2
      )
    }
  ];
}

export function buildRewriteMessages(
  request: GenerateRewriteRequest,
  styleProfileJson: string | undefined,
  examples: WritingExample[]
): ChatMessage[] {
  const mode = request.mode === "cheap" ? "cheap" : "standard";
  const suggestionCount = mode === "cheap" ? 2 : 5;
  return [
    {
      role: "system",
      content: [
        "You rewrite X drafts for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Preserve the user's meaning and do not invent facts, links, metrics, credentials, or personal experiences.",
        "Improve clarity, rhythm, tone, and specificity without making the draft sound automated.",
        "For posts, strengthen the first line, focus on one idea, and make the practical value obvious without adding engagement bait.",
        "For comments, make the reply a complete value-adding thought rather than generic agreement.",
        "Keep the result suitable for the requested kind: post or comment.",
        "Do not imply the helper saw any original X post unless the user included that context in the draft or instructions.",
        "Avoid engagement bait, spam, hashtags unless asked, and generic influencer phrasing.",
        "Do not copy or closely paraphrase past tweets; use similarPastWriting only as voice and style reference.",
        "Produce multiple distinct options, not minor paraphrases.",
        "Generate options the user can approve manually. Never claim to post, reply, like, repost, or perform actions.",
        mode === "cheap" ? "Be brief. Minimize rationale length." : ""
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "rewrite_draft",
          kind: request.kind,
          draftText: request.text,
          instructions: request.instructions ?? "",
          regenerationSeed: request.regenerationSeed ?? "initial",
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          similarPastWriting: examples.map(formatExample),
          requiredOutput: `Return ${suggestionCount} rewritten options with text, rationale, confidence. Preserve the original meaning and make the options meaningfully different.`
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
  const desiredOutcome = request.desiredOutcome ?? "earn relevant follows";
  return [
    {
      role: "system",
      content: [
        "You are a read-only X reaction opportunity selector.",
        "Rank visible posts for whether the user should react, but do not automate engagement.",
        "Recommend only one of: reply, quote idea, save for later, skip.",
        "Prefer posts where the user can add something useful, authentic, and non-spammy.",
        "Favor opportunities where the user can contribute a crisp opinion, practical detail, or original angle.",
        "Prefer posts from builders, founders, and engineers sharing concrete lessons, experiments, or technical tradeoffs.",
        "Prefer niches overlapping the stated audience over mega-viral low-context threads.",
        "Prioritize conversations where a strong reply could credibly introduce the user to the stated target audience.",
        "When desiredOutcome is 'earn relevant follows', boost posts where a substantive reply could attract peer founders/builders who share the user's niche.",
        "When desiredOutcome is 'start a useful conversation', prefer posts that invite a specific technical or founder discussion.",
        "A large audience or high metrics alone is not a reason to recommend a reply.",
        "Never recommend reply for comment-bait posts. Recommend skip instead and keep the score at or below 25.",
        "Treat as comment bait: like/comment/RT-if prompts, tag-someone asks, follow-for-follow or comment-to-get-DM hooks, fill-in-the-blank engagement farms, prove-me-wrong dunks with no substance, rate-this/1-10 asks, and posts whose main purpose is harvesting replies rather than sharing a useful idea.",
        "A thoughtful post that ends with one genuine question is not comment bait. Naked engagement questions and reply-harvesting posts are.",
        "Penalize ragebait, low-context posts, repetitive trends, and obvious promotional traps.",
        "Return only valid JSON matching the schema."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "score_visible_posts",
          visiblePosts: request.posts.slice(0, 24),
          targetAudience: request.audience ?? "the user's intended professional audience",
          contentPillar: request.contentPillar ?? "choose the strongest fit",
          desiredOutcome,
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          representativePastWriting: examples.map(formatExample).slice(0, 10),
          scoringCriteria: [
            "relevance to user's usual topics",
            "likelihood the user can add a useful reply",
            "relevance to the target audience",
            "author/audience overlap with target niche",
            "substantive builder/founder thread vs viral noise",
            "potential to demonstrate useful expertise without self-promotion",
            "alignment with desiredOutcome (follows vs conversation vs save-worthy)",
            "tone fit",
            "recency/context clarity",
            "spam/ragebait risk",
            "comment-bait / reply-harvesting risk"
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
