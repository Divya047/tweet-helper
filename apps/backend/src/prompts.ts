import type {
  GenerateCommentRequest,
  GeneratePostRequest,
  GenerateRewriteRequest,
  IntentAnalysis,
  DraftSuggestion,
  ScoreVisiblePostsRequest
} from "@tweet-helper/shared";
import type { WritingExample } from "./db.js";
import type { PersonalTasteProfile } from "./style.js";

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
  pairedExamples: Array<{sourceText:string;replyText:string}> = [],
  sourceIntent?: IntentAnalysis,
  tasteProfile?: PersonalTasteProfile
): ChatMessage[] {
  const mode = request.mode === "cheap" ? "cheap" : "standard";
  const suggestionCount = mode === "cheap" ? 4 : 5;
  const desiredOutcome = request.desiredOutcome ?? "earn relevant follows";
  return [
    {
      role: "system",
      content: [
        "You write concise X replies/comments for the user in their authentic voice.",
        "Return only valid JSON matching the schema.",
        "Do not harass, dogpile, spam, manipulate engagement, or imply the user read something they did not.",
        "Do not click or submit anything. The user will manually approve any draft.",
        "A separate short analysis already classified the source post. Treat sourceIntent as ground truth for what the post is doing and what a useful reply should accomplish.",
        "Address speechAct/claimOrAsk/replyObjective directly: answer the question, engage the claim, respond to the announcement, etc. Do not fall back to generic peer-expertise filler that ignores that analysis.",
        "Use sourceIntent.recommendedStance as the default stance. Change it only when the draft would otherwise be false, redundant, or unsupported.",
        "If sourceIntent.shouldReply is false, do not force expertise theater. Return candidate drafts only for the taste judge to inspect; it may abstain.",
        "When angle is provided, treat it as a preferred reply strategy within sourceIntent — not a replacement for it.",
        "Prefer replies that signal peer founder/builder expertise: an implementation detail, constraint, tradeoff, practical caveat, pattern, or well-reasoned question — when that fits the replyObjective.",
        "Never invent facts, links, metrics, credentials, or personal experiences.",
        "Do not default to anecdote openers like 'one time we…', 'we once…', or invented shipping stories. Prefer analytical, practical, or question-led structures unless the user's instructions or past writing supply a real detail to reuse carefully.",
        "When instructions name a reply tone, follow that structure exactly. Do not default to counterexample, exception, or 'but actually' framing unless the tone asks for it.",
        "When instructions name a voice register, match that cadence and diction exactly so drafts do not share one polished assistant rhythm.",
        "Sound like a specific person typing quickly on X, not a polished writing assistant.",
        "Vary sentence length and openings. Prefer contractions when natural. Uneven rhythm beats symmetric polish.",
        "Never open with applause or filler such as: Great point, Love this, This is underrated, So true, Couldn't agree more, One thing I'd add, Curious how you're thinking about.",
        "Avoid stock AI patterns: 'It's not X, it's Y', 'The real unlock is…', 'Here's the thing…', 'At the end of the day…', stacked em dashes, and neat three-part lists.",
        "Vary reply structure across options when no tone is specified: caveat, tradeoff, implementation detail, pattern, constructive pushback, reasoned question, or concise add-on — not minor paraphrases of the same tone.",
        "Write a complete thought that is useful even when read on its own, while still responding directly to the source post.",
        "When sourcePost, parentPost, or quotedPost includes media, inspect the attached images and use their actual content as context. Do not guess when an image is unavailable.",
        "When possible, contribute an implementation detail, implication, constraint, or well-reasoned question that the source author did not already state.",
        "Do not ask a question merely to get a response; earn the question with a useful premise first.",
        "Avoid generic agreement, applause, reply-guy energy, and comments that merely restate the source post.",
        "When the desired outcome is earning relevant follows or starting a useful conversation, make the reply strong enough that the author or their peer audience would want to know the user.",
        `Avoid overusing catchphrases from the user's past writing. Do not use the phrase "real flex" unless it appears in the source post or the user's instructions.`,
        "Do not copy or closely paraphrase past tweets; use similarPastWriting only as voice and style reference.",
        "Produce multiple distinct options, not minor paraphrases.",
        "Generate distinct candidates for a separate taste judge. Explore only stances that genuinely fit this source; never manufacture disagreement, a question, or a technical detail for variety.",
        "The first candidate need not be the winner. Candidate diversity exists to help the judge choose, not to fill a quota.",
        mode === "cheap" ? "Be brief. Minimize rationale length." : ""
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "generate_comment",
          sourcePost: request.sourcePost,
          sourceIntent: sourceIntent ?? null,
          angle: request.angle ?? "",
          targetAudience: request.audience ?? "the user's intended professional audience",
          contentPillar: request.contentPillar ?? "choose the strongest fit",
          desiredOutcome,
          instructions: request.instructions ?? "",
          regenerationSeed: request.regenerationSeed ?? "initial",
          styleProfile: styleProfileJson ? JSON.parse(styleProfileJson) : null,
          personalTasteProfile: tasteProfile ?? null,
          similarPastWriting: examples.map(formatExample),
          learnedSourceReplyPairs: pairedExamples,
          requiredOutput: `Return ${suggestionCount} reply suggestions with text, rationale, confidence. Suggestions must address sourceIntent. Ensure one suggestion is explicitly exploratory/different.`
        },
        null,
        2
      )
    }
  ];
}

export function buildTasteJudgeMessages(
  request: GenerateCommentRequest,
  sourceIntent: IntentAnalysis,
  candidates: DraftSuggestion[],
  tasteProfile: PersonalTasteProfile
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the user's strict reply editor and taste gate.",
        "Decide whether replying is better than silence, then rank the candidates.",
        "Return only valid JSON matching the schema.",
        "A technically correct reply can still be bad: reject predictable, performative, redundant, over-polished, reply-guy, or forced-expertise writing.",
        "Reward direct source fit, a genuinely distinct contribution, the user's learned voice, and restraint.",
        "Do not reward disagreement, questions, technicality, or cleverness for their own sake.",
        "Treat the user's skipped/rejected examples as negative preference evidence, never as text to imitate.",
        "Treat edited examples and editSignals as stronger evidence than generic style advice.",
        "Inspect attached source images when present; judge whether each reply fits both the written and visual context.",
        "Set shouldReply=false when no candidate clears 72/100, the source offers no honest opening, the reply merely restates the post, or silence better matches the user's taste.",
        "When shouldReply=true, recommendedId must identify the highest-scoring candidate.",
        "Score sourceFit, novelty, voiceFit, and restraint from 0-100. Overall score is not a simple average; a fatal flaw may dominate.",
        "Keep reasons and flags terse."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "judge_reply_taste",
          sourcePost: request.sourcePost,
          sourceIntent,
          requestedAngle: request.angle ?? "",
          userInstructions: request.instructions ?? "",
          desiredOutcome: request.desiredOutcome ?? "earn relevant follows",
          personalTasteProfile: tasteProfile,
          candidates
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
  _styleProfileJson: string | undefined,
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
        "Inspect attached images referenced by each post's media field. Score the meaning of charts, screenshots, memes, and image-only posts rather than treating them as missing context.",
        "Penalize ragebait, low-context posts, repetitive trends, and obvious promotional traps.",
        "For each post, also write topicSummary: an ultra-short plain-language summary of what the post is about (max 12 words).",
        "topicSummary must describe the subject matter only — not why to reply, not the score rationale, and not the author handle.",
        "Keep reason and suggestedAngle under 12 words each. Prefer empty risks unless there is a clear spam/bait risk.",
        "Score five dimensions from 0-100: contributionPotential, audienceFit, novelty, risk, and confidence.",
        "Novelty means different from the other visible opportunities without becoming irrelevant. Risk rises for bait, noise, weak context, or promotion.",
        "Do not include draftSeed unless it is under 12 words.",
        "Return only valid JSON matching the schema. Be concise — ranking speed matters."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "score_visible_posts",
          visiblePosts: request.posts.slice(0, 24).map((post) => ({
            id: post.id,
            ...(post.author ? { author: post.author } : {}),
            text: truncateForScore(post.text),
            ...(post.media?.length ? { media: post.media } : {}),
            ...(post.quotedPost ? { quotedPost: post.quotedPost } : {})
          })),
          targetAudience: request.audience ?? "the user's intended professional audience",
          contentPillar: request.contentPillar ?? "choose the strongest fit",
          desiredOutcome,
          representativePastWriting: examples.map(formatExample).slice(0, 3),
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
          requiredOutput: "rank each input post with score, recommendation, reason, suggestedAngle, topicSummary, contributionPotential, audienceFit, novelty, risk, confidence, optional draftSeed, risks"
        },
        null,
        2
      )
    }
  ];
}

function truncateForScore(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatExample(example: WritingExample): Pick<WritingExample, "kind" | "text" | "createdAt"> {
  return {
    kind: example.kind,
    text: example.text,
    createdAt: example.createdAt
  };
}
