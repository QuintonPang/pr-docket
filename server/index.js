import "dotenv/config";
import cors from "cors";
import express from "express";
import { fetchMergeRequest } from "./gitlab.js";
import { createQwenClient, reviewDiffFiles, runJudge, runReviewers } from "./reviewers.js";

const app = express();
const port = process.env.PORT || 3001;
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

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/review", async (request, response) => {
  const { diff } = request.body ?? {};
  if (typeof diff !== "string" || !diff.trim()) {
    return response.status(400).json({ error: "A non-empty diff string is required." });
  }
  if (!process.env.QWEN_API_KEY) {
    return response.status(503).json({ error: "QWEN_API_KEY is not configured on the server." });
  }

  try {
    const client = createQwenClient(process.env.QWEN_API_KEY);
    const reviewers = await runReviewers(client, diff);
    const judge = await runJudge(client, reviewers);
    return response.json({ reviewers, judge });
  } catch (error) {
    console.error("Review failed:", error);
    return response.status(500).json({ error: "The review could not be completed. Please try again." });
  }
});

app.post("/api/review-mr", async (request, response) => {
  const { url } = request.body ?? {};
  if (typeof url !== "string" || !url.trim()) {
    return response.status(400).json({ error: "A GitLab merge request URL is required." });
  }
  if (!process.env.QWEN_API_KEY) {
    return response.status(503).json({ error: "QWEN_API_KEY is not configured on the server." });
  }
  try {
    const mergeRequest = await fetchMergeRequest(url.trim(), {
      baseUrl: process.env.GITLAB_URL || "https://gitlab.com",
      token: process.env.GITLAB_TOKEN,
    });
    const client = createQwenClient(process.env.QWEN_API_KEY);
    const review = await reviewDiffFiles(client, mergeRequest.files);
    const { files: _files, ...metadata } = mergeRequest;
    return response.json({ ...review, merge_request: metadata });
  } catch (error) {
    console.error("Merge request review failed:", error);
    const expected = ["valid GitLab", "URLs must", "Use a GitLab", "denied access", "not found", "no reviewable", "too large", "GitLab returned"];
    const status = expected.some((text) => error.message.includes(text)) ? 400 : 500;
    return response.status(status).json({ error: status === 400 ? error.message : "The merge request review could not be completed." });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`PR Docket server listening on http://localhost:${port}`);
});
