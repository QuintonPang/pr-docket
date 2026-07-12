import "dotenv/config";
import cors from "cors";
import express from "express";
import { fetchMergeRequest, postMergeRequestNote } from "./gitlab.js";
import {
  DEFAULT_REVIEWER_KEYS,
  createQwenClient,
  personas,
  reconcileReviewers,
  reviewDiffFiles,
  runJudge,
  runReviewers,
  suggestFixes,
} from "./reviewers.js";

const app = express();
const port = process.env.PORT || 3001;
const MAX_DIFF_LENGTH = 120_000;
const MAX_MR_URL_LENGTH = 2_000;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include health checks and server-to-server calls.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
}));
app.use(express.json({ limit: "2mb" }));
app.use((request, response, next) => {
  const startedAt = Date.now();
  console.log(`[request] ${request.method} ${request.originalUrl}`);
  response.on("finish", () => {
    console.log(`[response] ${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/ready", (_request, response) => {
  const missing = ["QWEN_API_KEY"].filter((name) => !process.env[name]);
  if (missing.length) {
    return response.status(503).json({ status: "not_ready", missing });
  }
  return response.json({ status: "ready" });
});

app.post("/api/review", async (request, response) => {
  const { diff, policy, reviewers } = request.body ?? {};
  if (typeof diff !== "string" || !diff.trim()) {
    return response.status(400).json({ error: "A non-empty diff string is required." });
  }
  if (diff.length > MAX_DIFF_LENGTH) {
    return response.status(413).json({
      error: `Diff is too large for direct review. Submit a diff under ${MAX_DIFF_LENGTH} characters or use a GitLab merge request URL.`,
    });
  }
  if (!process.env.QWEN_API_KEY) {
    return response.status(503).json({ error: "QWEN_API_KEY is not configured on the server." });
  }

  try {
    const policyText = formatReviewPolicy(policy);
    const reviewerKeys = normalizeReviewerSelection(reviewers);
    const client = createQwenClient(process.env.QWEN_API_KEY);
    const reviewerResults = await runReviewers(client, diff, policyText, reviewerKeys);
    const { reviewers: reconciledReviewers, debate } = await reconcileReviewers(client, reviewerResults);
    const judge = await runJudge(client, reconciledReviewers);
    const ci = buildCiVerdict(reconciledReviewers);
    const fixSuggestions = ci.passed ? [] : (await suggestFixes(client, diff, reconciledReviewers)).fix_suggestions;
    return response.json({
      reviewers: reconciledReviewers,
      debate,
      judge,
      ci,
      fix_suggestions: fixSuggestions,
      policy_applied: Boolean(policyText),
      reviewer_keys: reviewerKeys,
    });
  } catch (error) {
    console.error("Review failed:", error);
    if (error.message.includes("Qwen API key")) {
      return response.status(503).json({ error: error.message });
    }
    const status = error.message.includes("policy") || error.message.includes("reviewers") ? 400 : 500;
    return response.status(status).json({ error: status === 400 ? error.message : "The review could not be completed. Please try again." });
  }
});

app.post("/api/review-mr", async (request, response) => {
  const { url, post_comment: postComment = false, policy, reviewers } = request.body ?? {};
  if (typeof url !== "string" || !url.trim()) {
    return response.status(400).json({ error: "A GitLab merge request URL is required." });
  }
  if (typeof postComment !== "boolean") {
    return response.status(400).json({ error: "post_comment must be a boolean when provided." });
  }
  if (url.length > MAX_MR_URL_LENGTH) {
    return response.status(413).json({ error: "Merge request URL is too long." });
  }
  if (!process.env.QWEN_API_KEY) {
    return response.status(503).json({ error: "QWEN_API_KEY is not configured on the server." });
  }
  try {
    const policyText = formatReviewPolicy(policy);
    const reviewerKeys = normalizeReviewerSelection(reviewers);
    const mergeRequest = await fetchMergeRequest(url.trim(), {
      baseUrl: process.env.GITLAB_URL || "https://gitlab.com",
      token: process.env.GITLAB_TOKEN,
    });
    const client = createQwenClient(process.env.QWEN_API_KEY);
    const review = await reviewDiffFiles(client, mergeRequest.files, policyText, reviewerKeys);
    const { files: _files, ...metadata } = mergeRequest;
    const result = {
      ...review,
      ci: buildCiVerdict(review.reviewers),
      merge_request: metadata,
      policy_applied: Boolean(policyText),
      reviewer_keys: reviewerKeys,
    };
    result.fix_suggestions = result.ci.passed
      ? []
      : (await suggestFixes(client, mergeRequest.files.join("\n\n"), review.reviewers)).fix_suggestions;

    if (postComment) {
      try {
        result.gitlab_comment = await postMergeRequestNote(
          url.trim(),
          formatMergeRequestComment(result),
          {
            baseUrl: process.env.GITLAB_URL || "https://gitlab.com",
            token: process.env.GITLAB_TOKEN,
          },
        );
      } catch (commentError) {
        console.error("GitLab comment posting failed:", commentError);
        result.gitlab_comment = {
          posted_to_gitlab: false,
          error: commentError.message,
        };
      }
    }

    return response.json(result);
  } catch (error) {
    console.error("Merge request review failed:", error);
    if (error.message.includes("Qwen API key")) {
      return response.status(503).json({ error: error.message });
    }
    const expected = ["valid GitLab", "URLs must", "Use a GitLab", "denied access", "not found", "no reviewable", "too large", "GitLab returned", "policy", "reviewers"];
    const status = expected.some((text) => error.message.includes(text)) ? 400 : 500;
    return response.status(status).json({ error: status === 400 ? error.message : "The merge request review could not be completed." });
  }
});

function normalizeReviewerSelection(value) {
  if (value == null) return DEFAULT_REVIEWER_KEYS;
  if (!Array.isArray(value)) throw new Error("reviewers must be an array of reviewer keys when provided.");
  const availableKeys = new Set(personas.map((persona) => persona.key));
  const keys = [...new Set(value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`reviewers[${index}] must be a string.`);
    return item.trim();
  }).filter(Boolean))];

  if (!keys.length) throw new Error("reviewers must include at least one reviewer key.");
  if (keys.length > 5) throw new Error("reviewers cannot include more than 5 reviewers.");
  const unknown = keys.filter((key) => !availableKeys.has(key));
  if (unknown.length) throw new Error(`Unknown reviewers: ${unknown.join(", ")}.`);
  return keys;
}

function formatReviewPolicy(policy) {
  if (policy == null) return "";
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("policy must be an object when provided.");
  }

  const lines = [];
  if (Array.isArray(policy.require_tests_for)) {
    const paths = cleanStringList(policy.require_tests_for, "policy.require_tests_for");
    if (paths.length) lines.push(`Require tests for changes under: ${paths.join(", ")}.`);
  }

  if (Array.isArray(policy.forbidden_patterns)) {
    const patterns = policy.forbidden_patterns.slice(0, 20).map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`policy.forbidden_patterns[${index}] must be an object.`);
      }
      const name = cleanPolicyString(item.name, `policy.forbidden_patterns[${index}].name`);
      const pattern = cleanPolicyString(item.pattern, `policy.forbidden_patterns[${index}].pattern`);
      const severity = normalizePolicySeverity(item.severity, `policy.forbidden_patterns[${index}].severity`);
      return `${name} (${pattern}) severity ${severity}`;
    });
    if (patterns.length) lines.push(`Forbidden patterns: ${patterns.join("; ")}.`);
  }

  if (Array.isArray(policy.extra_instructions)) {
    const instructions = cleanStringList(policy.extra_instructions, "policy.extra_instructions");
    if (instructions.length) lines.push(`Extra instructions: ${instructions.join(" ")}`);
  }

  if (!lines.length) throw new Error("policy must include require_tests_for, forbidden_patterns, or extra_instructions.");
  return lines.join("\n");
}

function cleanStringList(value, fieldName) {
  return value.slice(0, 20).map((item, index) => cleanPolicyString(item, `${fieldName}[${index}]`)).filter(Boolean);
}

function cleanPolicyString(value, fieldName) {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string.`);
  const cleaned = value.trim();
  if (cleaned.length > 200) throw new Error(`${fieldName} must be 200 characters or fewer.`);
  return cleaned;
}

function normalizePolicySeverity(value, fieldName) {
  const severity = Number(value);
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
    throw new Error(`${fieldName} must be an integer from 1 to 5.`);
  }
  return severity;
}

function buildCiVerdict(reviewers) {
  const severities = reviewers.map((reviewer) => Number(reviewer.severity) || 0);
  const maxSeverity = Math.max(0, ...severities);
  const blockingCount = severities.filter((severity) => severity >= 4).length;
  return {
    passed: blockingCount === 0,
    max_severity: maxSeverity,
    blocking_count: blockingCount,
    exit_code: blockingCount === 0 ? 0 : 1,
  };
}

function formatMergeRequestComment(review) {
  const blockingIssues = review.reviewers
    .flatMap((reviewer) => reviewer.issues.map((issue) => ({ reviewer: reviewer.key, issue })))
    .filter(({ issue }) => Number(issue.severity) >= 4)
    .slice(0, 5);
  const fallbackIssues = review.reviewers
    .flatMap((reviewer) => reviewer.issues.map((issue) => ({ reviewer: reviewer.key, issue })))
    .slice(0, 5);
  const issues = blockingIssues.length ? blockingIssues : fallbackIssues;
  const issueLines = issues.length
    ? issues.map(({ reviewer, issue }, index) => [
      `${index + 1}. **${issue.title}** (${reviewer}, severity ${issue.severity}, ${issue.confidence} confidence)`,
      `   - Location: \`${issue.file}:${issue.line_hint}\``,
      `   - Evidence: ${issue.evidence}`,
      `   - Recommendation: ${issue.recommendation}`,
    ].join("\n")).join("\n")
    : "No concrete issues were reported by the specialist reviewers.";

  return [
    "## PR Docket Review",
    "",
    `**Verdict:** ${review.judge.verdict}`,
    `**CI gate:** ${review.ci.passed ? "passed" : "failed"} (exit code ${review.ci.exit_code})`,
    `**Blocking findings:** ${review.judge.blocking_count}`,
    `**Reviewed files:** ${review.merge_request.reviewed_file_count}/${review.merge_request.file_count}`,
    "",
    "### Debate clerk",
    review.debate?.summary || "Specialist findings were reconciled before judging.",
    "",
    "### Judge rationale",
    review.judge.rationale,
    "",
    "### Top findings",
    issueLines,
    "",
    "_Generated by PR Docket using Qwen specialist reviewers and a judge agent._",
  ].join("\n");
}

app.listen(port, "0.0.0.0", () => {
  console.log(`PR Docket server listening on http://localhost:${port}`);
});
