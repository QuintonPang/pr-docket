import OpenAI from "openai";

const MODEL = "qwen-plus";
const LLM_TIMEOUT_MS = 20_000;
const JSON_RULE = `Return ONLY a valid JSON object with exactly this shape:
{"verdict":"approve"|"request changes"|"comment","severity":1-5,"issues":[{"title":"short issue title","file":"path/to/file or unknown","line_hint":"+12 or unknown","severity":1-5,"confidence":"high"|"medium"|"low","evidence":"specific diff evidence","recommendation":"specific fix"}]}
Do not use markdown, code fences, a preamble, or fields outside this schema. Severity 5 is critical and 1 is informational. Only include issues directly evidenced by the supplied diff.`;

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
  {
    key: "testing",
    name: "Testing Counsel",
    system: `You are a testing-focused code reviewer. Inspect the supplied git diff for missing test coverage, weak assertions, brittle tests, untested edge cases, and changes that should include regression tests. Be precise, practical, and only report issues evidenced by the diff. ${JSON_RULE}`,
  },
  {
    key: "cloud_cost",
    name: "Cloud Cost Counsel",
    system: `You are a cloud cost and operations reviewer. Inspect the supplied git diff for wasteful network calls, unbounded model/API usage, expensive polling, missing limits, inefficient storage or compute use, and deployment choices that could increase cloud bills. Be precise, practical, and only report issues evidenced by the diff. ${JSON_RULE}`,
  },
];

export const DEFAULT_REVIEWER_KEYS = ["security", "performance", "readability"];

const reviewerFallback = {
  verdict: "comment",
  severity: 1,
  issues: [{
    title: "Unreadable reviewer response",
    file: "unknown",
    line_hint: "unknown",
    severity: 1,
    confidence: "low",
    evidence: "The reviewer returned an unreadable response.",
    recommendation: "Run a manual review or retry the request.",
  }],
};

const judgeFallback = (reviewers) => {
  const blockingCount = reviewers.filter((reviewer) => reviewer.severity >= 4).length;
  return {
    verdict: blockingCount ? "changes requested" : "needs discussion",
    rationale: "The judge returned an unreadable response. The docket has preserved the specialist findings so they can be assessed manually.",
    reviewer_count: reviewers.length,
    blocking_count: blockingCount,
    suggestion_count: reviewers.length - blockingCount,
  };
};

const debateFallback = (reviewers) => ({
  reviewers,
  debate: {
    resolved_conflicts: [],
    removed_findings: [],
    summary: "The reconciliation agent could not refine the specialist findings, so the original reviewer output was preserved.",
  },
});

const fixSuggestionFallback = {
  fix_suggestions: [],
};

function extractJson(content) {
  if (typeof content !== "string") throw new Error("Model response was empty");
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractFirstJsonObject(cleaned);
    if (!extracted) throw new Error("Model response did not contain a JSON object");
    return JSON.parse(extracted);
  }
}

function extractFirstJsonObject(content) {
  const start = content.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return content.slice(start, index + 1);
  }
  return "";
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
    issues: value.issues.map(normalizeIssue).filter(Boolean).slice(0, 10),
  };
}

function normalizeIssue(value) {
  if (typeof value === "string") {
    const title = value.trim();
    if (!title) return null;
    return {
      title,
      file: "unknown",
      line_hint: "unknown",
      severity: 1,
      confidence: "low",
      evidence: title,
      recommendation: "Review this finding manually.",
    };
  }

  if (!value || typeof value !== "object") return null;
  const title = String(value.title || "").trim();
  const evidence = String(value.evidence || "").trim();
  const recommendation = String(value.recommendation || "").trim();
  if (!title || !evidence || !recommendation) return null;

  const severity = Number(value.severity);
  const confidence = ["high", "medium", "low"].includes(value.confidence) ? value.confidence : "medium";

  return {
    title,
    file: String(value.file || "unknown").trim() || "unknown",
    line_hint: String(value.line_hint || "unknown").trim() || "unknown",
    severity: Number.isInteger(severity) && severity >= 1 && severity <= 5 ? severity : 1,
    confidence,
    evidence,
    recommendation,
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
    reviewer_count: reviewers.length,
    blocking_count: blockingCount,
    suggestion_count: reviewers.length - blockingCount,
  };
}

function normalizeDebate(value, originalReviewers) {
  if (!value || !Array.isArray(value.reviewers) || !value.debate || typeof value.debate !== "object") {
    throw new Error("Debate response did not match the schema");
  }

  const reviewerKeys = originalReviewers.map((reviewer) => reviewer.key);
  const reviewersByKey = new Map(originalReviewers.map((reviewer) => [reviewer.key, reviewer]));
  const reviewers = reviewerKeys.map((key) => {
    const source = value.reviewers.find((reviewer) => reviewer?.key === key);
    if (!source) return reviewersByKey.get(key);
    const normalized = normalizeReviewer(source);
    return { key, ...normalized };
  });

  return {
    reviewers,
    debate: {
      resolved_conflicts: normalizeTextArray(value.debate.resolved_conflicts).slice(0, 10),
      removed_findings: normalizeTextArray(value.debate.removed_findings).slice(0, 10),
      summary: String(value.debate.summary || "Specialist findings were reconciled before judging.").trim(),
    },
  };
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeFixSuggestions(value) {
  if (!value || !Array.isArray(value.fix_suggestions)) {
    throw new Error("Fix suggestion response did not match the schema");
  }

  return {
    fix_suggestions: value.fix_suggestions.map(normalizeFixSuggestion).filter(Boolean).slice(0, 5),
  };
}

function normalizeFixSuggestion(value) {
  if (!value || typeof value !== "object") return null;
  const title = String(value.title || "").trim();
  const file = String(value.file || "unknown").trim() || "unknown";
  const risk = String(value.risk || "").trim();
  const suggestedPatch = String(value.suggested_patch || "").trim();
  const confidence = ["high", "medium", "low"].includes(value.confidence) ? value.confidence : "medium";

  if (!title || !risk || !suggestedPatch) return null;
  return {
    title,
    file,
    risk,
    suggested_patch: suggestedPatch,
    confidence,
  };
}

async function jsonCall(client, messages, normalize, fallback) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retryMessages = attempt === 0
        ? messages
        : [
          ...messages,
          {
            role: "user",
            content: `Your previous response could not be parsed as valid JSON (${lastError}). Retry now. Return exactly one valid JSON object and nothing else.`,
          },
        ];
      const completion = await client.chat.completions.create(
        {
          model: MODEL,
          messages: retryMessages,
          response_format: { type: "json_object" },
          max_tokens: 1800,
          temperature: 0.2,
        },
        { timeout: LLM_TIMEOUT_MS },
      );
      return normalize(extractJson(completion.choices[0]?.message?.content));
    } catch (error) {
      if (isProviderConfigurationError(error)) {
        throw new Error("Qwen API key was rejected by Alibaba Cloud. Check QWEN_API_KEY in server/.env and restart the backend.");
      }
      lastError = error.message;
      console.warn(`LLM attempt ${attempt + 1} failed:`, error.message);
    }
  }
  return fallback;
}

function isProviderConfigurationError(error) {
  return error?.status === 401
    || error?.code === "invalid_api_key"
    || String(error?.message || "").toLowerCase().includes("incorrect api key");
}

export function createQwenClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  });
}

function selectPersonas(reviewerKeys = DEFAULT_REVIEWER_KEYS) {
  const requested = new Set(reviewerKeys);
  return personas.filter((persona) => requested.has(persona.key));
}

export async function runReviewers(client, diff, policyText = "", reviewerKeys = DEFAULT_REVIEWER_KEYS) {
  const policySection = policyText ? `\n\nTeam review policy:\n${policyText}` : "";
  const activePersonas = selectPersonas(reviewerKeys);
  console.log(`[llm] starting ${activePersonas.length} reviewer agent(s)`);
  return Promise.all(
    activePersonas.map(async (persona) => {
      console.log(`[llm] reviewer:${persona.key} started`);
      const output = await jsonCall(
        client,
        [
          { role: "system", content: persona.system },
          { role: "user", content: `Review this git diff:${policySection}\n\n${diff}` },
        ],
        normalizeReviewer,
        { ...reviewerFallback, issues: [...reviewerFallback.issues] },
      );
      console.log(`[llm] reviewer:${persona.key} finished with ${output.verdict} severity ${output.severity}`);
      return { key: persona.key, ...output };
    }),
  );
}

export async function runJudge(client, reviewers) {
  console.log("[llm] judge started");
  const system = `You are the presiding judge for a code review. Weigh the supplied specialist findings and produce the final verdict. A severity of 4 or 5 is blocking. Return ONLY valid JSON with exactly this shape: {"verdict":"merge"|"changes requested"|"needs discussion","rationale":"2-3 sentence explanation","reviewer_count":0,"blocking_count":0,"suggestion_count":0}. Do not use markdown or a preamble. Counts must reflect the supplied reviews.`;
  const output = await jsonCall(
    client,
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(reviewers) },
    ],
    (value) => normalizeJudge(value, reviewers),
    judgeFallback(reviewers),
  );
  console.log(`[llm] judge finished with ${output.verdict}`);
  return output;
}

export async function reconcileReviewers(client, reviewers) {
  console.log("[llm] debate clerk started");
  const allowedKeys = reviewers.map((reviewer) => reviewer.key).join("|");
  const system = `You are the debate clerk for a multi-agent code review. Reconcile the supplied specialist findings before the judge sees them. Merge duplicate findings, remove findings not directly evidenced by the diff summaries, preserve serious blocking issues, and flag meaningful disagreements. Return ONLY valid JSON with exactly this shape: {"reviewers":[{"key":"${allowedKeys}","verdict":"approve"|"request changes"|"comment","severity":1-5,"issues":[{"title":"short issue title","file":"path/to/file or unknown","line_hint":"+12 or unknown","severity":1-5,"confidence":"high"|"medium"|"low","evidence":"specific diff evidence","recommendation":"specific fix"}]}],"debate":{"resolved_conflicts":["short note"],"removed_findings":["short note"],"summary":"1-2 sentence reconciliation summary"}}. Do not use markdown or a preamble.`;
  const output = await jsonCall(
    client,
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(reviewers) },
    ],
    (value) => normalizeDebate(value, reviewers),
    debateFallback(reviewers),
  );
  console.log("[llm] debate clerk finished");
  return output;
}

export async function suggestFixes(client, diff, reviewers) {
  const blockingIssues = reviewers
    .flatMap((reviewer) => reviewer.issues.map((issue) => ({ reviewer: reviewer.key, issue })))
    .filter(({ issue }) => Number(issue.severity) >= 4)
    .slice(0, 5);

  if (!blockingIssues.length) return fixSuggestionFallback;

  console.log("[llm] fix suggestions started");
  const system = `You are a senior engineer proposing safe remediation suggestions for blocking code-review findings. Generate suggestions only for issues directly evidenced by the supplied diff and findings. Do not claim a patch is guaranteed correct. Return ONLY valid JSON with exactly this shape: {"fix_suggestions":[{"title":"short fix title","file":"path/to/file or unknown","risk":"risk being fixed","suggested_patch":"unified diff snippet or code-level change suggestion","confidence":"high"|"medium"|"low"}]}. Do not use markdown fences, a preamble, or fields outside this schema.`;
  const output = await jsonCall(
    client,
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ blocking_issues: blockingIssues, diff: diff.slice(0, 20_000) }) },
    ],
    normalizeFixSuggestions,
    fixSuggestionFallback,
  );
  console.log(`[llm] fix suggestions finished with ${output.fix_suggestions.length} suggestion(s)`);
  return output;
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

function aggregateReviews(batchReviews, reviewerKeys = DEFAULT_REVIEWER_KEYS) {
  return reviewerKeys.map((key) => {
    const reviews = batchReviews.map((batch) => batch.find((review) => review.key === key));
    const severity = Math.max(...reviews.map((review) => review.severity));
    const issues = dedupeIssues(reviews.flatMap((review) => review.issues)).slice(0, 15);
    const verdict = severity >= 4
      ? "request changes"
      : reviews.some((review) => review.verdict !== "approve") ? "comment" : "approve";
    return { key, verdict, severity, issues };
  });
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = [
      issue.file,
      issue.line_hint,
      issue.title.toLowerCase(),
      issue.evidence.toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function reviewDiffFiles(client, fileDiffs, policyText = "", reviewerKeys = DEFAULT_REVIEWER_KEYS) {
  const batches = batchDiffs(fileDiffs);
  console.log(`[mr] reviewing ${fileDiffs.length} file diff(s) in ${batches.length} batch(es)`);
  const batchReviews = [];
  for (const [index, batch] of batches.entries()) {
    // Each batch still runs its three specialists in parallel, while batches stay
    // sequential to avoid multiplying API concurrency on a large merge request.
    console.log(`[mr] batch ${index + 1}/${batches.length} started`);
    batchReviews.push(await runReviewers(client, batch, policyText, reviewerKeys));
    console.log(`[mr] batch ${index + 1}/${batches.length} finished`);
  }
  const reviewers = aggregateReviews(batchReviews, reviewerKeys);
  const { reviewers: reconciledReviewers, debate } = await reconcileReviewers(client, reviewers);
  const judge = await runJudge(client, reconciledReviewers);
  return { reviewers: reconciledReviewers, debate, judge, batch_count: batches.length };
}
