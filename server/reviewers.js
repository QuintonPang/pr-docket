import OpenAI from "openai";

const MODEL = "qwen-plus";
const JSON_RULE = `Return ONLY a valid JSON object with exactly this shape:
{"verdict":"approve"|"request changes"|"comment","severity":1-5,"issues":["short issue description"]}
Do not use markdown, code fences, a preamble, or fields outside this schema. Severity 5 is critical and 1 is informational.`;

export const personas = [
  {
    key: "security",
    name: "Security Counsel",
    system: `You are a security-focused code reviewer. Inspect the supplied git diff for injection risks, missing input validation, secrets in code, authentication or authorization bypasses, and unsafe deserialization. Be precise, practical, and only report issues evidenced by the diff. ${JSON_RULE}`,
  },
  {
    key: "performance",
    name: "Performance Counsel",
    system: `You are a performance-focused code reviewer. Inspect the supplied git diff for N+1 queries, unnecessary loops, missing indexes or caching, excessive allocations, and inefficient algorithms. Be precise, practical, and only report issues evidenced by the diff. ${JSON_RULE}`,
  },
  {
    key: "readability",
    name: "Readability Counsel",
    system: `You are a readability and maintainability code reviewer. Inspect the supplied git diff for unclear naming, excessive complexity, missing documentation or tests, duplication, and unclear logic. Be precise, practical, and only report issues evidenced by the diff. ${JSON_RULE}`,
  },
];

const reviewerFallback = {
  verdict: "comment",
  severity: 1,
  issues: ["The reviewer returned an unreadable response; manual review is recommended."],
};

const judgeFallback = (reviewers) => {
  const blockingCount = reviewers.filter((reviewer) => reviewer.severity >= 4).length;
  return {
    verdict: blockingCount ? "changes requested" : "needs discussion",
    rationale: "The judge returned an unreadable response. The docket has preserved the specialist findings so they can be assessed manually.",
    reviewer_count: 3,
    blocking_count: blockingCount,
    suggestion_count: reviewers.length - blockingCount,
  };
};

function extractJson(content) {
  if (typeof content !== "string") throw new Error("Model response was empty");
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function normalizeReviewer(value) {
  const verdicts = ["approve", "request changes", "comment"];
  if (!value || !verdicts.includes(value.verdict) || !Array.isArray(value.issues)) {
    throw new Error("Reviewer response did not match the schema");
  }
  const severity = Number(value.severity);
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
    throw new Error("Reviewer severity was invalid");
  }
  return {
    verdict: value.verdict,
    severity,
    issues: value.issues.map(String).filter(Boolean).slice(0, 10),
  };
}

function normalizeJudge(value, reviewers) {
  const verdicts = ["merge", "changes requested", "needs discussion"];
  if (!value || !verdicts.includes(value.verdict) || typeof value.rationale !== "string") {
    throw new Error("Judge response did not match the schema");
  }
  const blockingCount = reviewers.filter((reviewer) => reviewer.severity >= 4).length;
  return {
    verdict: value.verdict,
    rationale: value.rationale.trim(),
    reviewer_count: 3,
    blocking_count: blockingCount,
    suggestion_count: reviewers.length - blockingCount,
  };
}

async function jsonCall(client, messages, normalize, fallback) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
      return normalize(extractJson(completion.choices[0]?.message?.content));
    } catch (error) {
      console.warn(`LLM attempt ${attempt + 1} failed:`, error.message);
    }
  }
  return fallback;
}

export function createQwenClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  });
}

export async function runReviewers(client, diff) {
  return Promise.all(
    personas.map(async (persona) => {
      const output = await jsonCall(
        client,
        [
          { role: "system", content: persona.system },
          { role: "user", content: `Review this git diff:\n\n${diff}` },
        ],
        normalizeReviewer,
        { ...reviewerFallback, issues: [...reviewerFallback.issues] },
      );
      return { key: persona.key, ...output };
    }),
  );
}

export async function runJudge(client, reviewers) {
  const system = `You are the presiding judge for a code review. Weigh three specialist findings and produce the final verdict. A severity of 4 or 5 is blocking. Return ONLY valid JSON with exactly this shape: {"verdict":"merge"|"changes requested"|"needs discussion","rationale":"2-3 sentence explanation","reviewer_count":3,"blocking_count":0,"suggestion_count":3}. Do not use markdown or a preamble. Counts must reflect the supplied reviews.`;
  return jsonCall(
    client,
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(reviewers) },
    ],
    (value) => normalizeJudge(value, reviewers),
    judgeFallback(reviewers),
  );
}

const BATCH_CHARACTER_LIMIT = 30_000;

export function batchDiffs(fileDiffs, limit = BATCH_CHARACTER_LIMIT) {
  const batches = [];
  let current = "";
  for (const diff of fileDiffs) {
    if (current && current.length + diff.length > limit) {
      batches.push(current);
      current = "";
    }
    if (diff.length > limit) {
      if (current) batches.push(current);
      batches.push(diff.slice(0, limit));
      current = "";
    } else {
      current += `${current ? "\n\n" : ""}${diff}`;
    }
  }
  if (current) batches.push(current);
  return batches;
}

function aggregateReviews(batchReviews) {
  return personas.map(({ key }) => {
    const reviews = batchReviews.map((batch) => batch.find((review) => review.key === key));
    const severity = Math.max(...reviews.map((review) => review.severity));
    const issues = [...new Set(reviews.flatMap((review) => review.issues))].slice(0, 15);
    const verdict = severity >= 4
      ? "request changes"
      : reviews.some((review) => review.verdict !== "approve") ? "comment" : "approve";
    return { key, verdict, severity, issues };
  });
}

export async function reviewDiffFiles(client, fileDiffs) {
  const batches = batchDiffs(fileDiffs);
  const batchReviews = [];
  for (const batch of batches) {
    // Each batch still runs its three specialists in parallel, while batches stay
    // sequential to avoid multiplying API concurrency on a large merge request.
    batchReviews.push(await runReviewers(client, batch));
  }
  const reviewers = aggregateReviews(batchReviews);
  const judge = await runJudge(client, reviewers);
  return { reviewers, judge, batch_count: batches.length };
}
