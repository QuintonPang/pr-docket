import { useState } from "react";

const API_URL = import.meta.env.VITE_REVIEW_API_URL || "http://localhost:3001/api/review";
const MR_API_URL = import.meta.env.VITE_MR_REVIEW_API_URL || API_URL.replace(/\/review\/?$/, "/review-mr");

const sampleDiff = `diff --git a/routes/users.js b/routes/users.js
index 4ca31ab..71d42cc 100644
--- a/routes/users.js
+++ b/routes/users.js
@@ -12,7 +12,17 @@ router.get('/search', async (req, res) => {
-  const users = await db.query('SELECT * FROM users WHERE active = true');
-  res.json(users);
+  const q = req.query.q;
+  const users = await db.query("SELECT * FROM users WHERE name LIKE '%" + q + "%'");
+  const x = [];
+  for (const user of users) {
+    const orders = await db.query('SELECT * FROM orders WHERE user_id = ?', [user.id]);
+    const ai = await qwen.chat.completions.create({ model: 'qwen-plus', messages: [{ role: 'user', content: user.name }] });
+    x.push({ ...user, orders, ai });
+  }
+  res.json(x);
 });`;

const meta = {
  security: { icon: "§", name: "Security Counsel" },
  performance: { icon: "⌁", name: "Performance Counsel" },
  readability: { icon: "¶", name: "Readability Counsel" },
  testing: { icon: "✓", name: "Testing Counsel" },
  cloud_cost: { icon: "$", name: "Cloud Cost Counsel" },
};

const reviewerOptions = Object.entries(meta).map(([key, value]) => ({ key, ...value }));
const defaultReviewers = ["security", "performance", "testing", "cloud_cost"];
const strictPolicy = {
  require_tests_for: ["routes/", "server/"],
  forbidden_patterns: [
    { name: "Hardcoded secret", pattern: "sk-", severity: 5 },
    { name: "Production console logging", pattern: "console.log", severity: 2 },
  ],
  extra_instructions: [
    "Flag missing authorization checks.",
    "Prefer findings with file and line evidence.",
  ],
};

function label(value) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function IssueItem({ issue }) {
  if (typeof issue === "string") return <li>{issue}</li>;

  return (
    <li>
      <strong>{issue.title}</strong>
      <span> {issue.file || "unknown"}:{issue.line_hint || "unknown"} · severity {issue.severity || "?"} · {issue.confidence || "medium"} confidence</span>
      <p>{issue.evidence}</p>
      <p>{issue.recommendation}</p>
    </li>
  );
}

function ReviewerCard({ reviewer, index }) {
  const details = meta[reviewer.key] || { icon: "•", name: reviewer.key };
  return (
    <article className={`reviewer-card ${reviewer.key}`} style={{ animationDelay: `${index * 120}ms` }}>
      <div className="card-top">
        <span className="agent-icon" aria-hidden="true">{details.icon}</span>
        <div><p className="eyebrow">Agent {index + 1}</p><h3>{details.name}</h3></div>
      </div>
      <div className="verdict-row">
        <span className={`pill verdict-${reviewer.verdict.replace(" ", "-")}`}>{label(reviewer.verdict)}</span>
        <span className="severity">Severity {reviewer.severity}/5</span>
      </div>
      {reviewer.issues.length
        ? <ul>{reviewer.issues.map((issue, itemIndex) => <IssueItem key={itemIndex} issue={issue} />)}</ul>
        : <p className="clear-note">No issues entered into the docket.</p>}
    </article>
  );
}

function DebateCard({ debate }) {
  if (!debate) return null;

  return (
    <article className="judge-card">
      <div className="judge-heading"><div className="gavel" aria-hidden="true">↔</div><div><p className="eyebrow">Debate clerk</p><h2>Findings reconciled</h2></div></div>
      <p className="rationale">{debate.summary}</p>
      {(debate.resolved_conflicts?.length > 0 || debate.removed_findings?.length > 0) && <dl>
        <div><dt>Resolved</dt><dd>{debate.resolved_conflicts?.length || 0}</dd></div>
        <div><dt>Removed</dt><dd>{debate.removed_findings?.length || 0}</dd></div>
      </dl>}
    </article>
  );
}

function FixSuggestions({ suggestions }) {
  if (!suggestions?.length) return null;

  return (
    <article className="judge-card">
      <div className="judge-heading"><div className="gavel" aria-hidden="true">✓</div><div><p className="eyebrow">Remediation</p><h2>Suggested fixes</h2></div></div>
      <ul>
        {suggestions.map((suggestion, index) => <li key={index}>
          <strong>{suggestion.title}</strong>
          <span> {suggestion.file || "unknown"} · {suggestion.confidence || "medium"} confidence</span>
          <p>{suggestion.risk}</p>
          <pre>{suggestion.suggested_patch}</pre>
        </li>)}
      </ul>
    </article>
  );
}

function CiGate({ ci }) {
  if (!ci) return null;

  return (
    <article className={`ci-card ${ci.passed ? "passed" : "failed"}`}>
      <div>
        <p className="eyebrow">CI gate</p>
        <h2>{ci.passed ? "Passed" : "Failed"}</h2>
      </div>
      <dl>
        <div><dt>Exit</dt><dd>{ci.exit_code}</dd></div>
        <div><dt>Max severity</dt><dd>{ci.max_severity}</dd></div>
        <div><dt>Blocking</dt><dd>{ci.blocking_count}</dd></div>
      </dl>
    </article>
  );
}

function App() {
  const [mode, setMode] = useState("diff");
  const [diff, setDiff] = useState(sampleDiff);
  const [mrUrl, setMrUrl] = useState("");
  const [selectedReviewers, setSelectedReviewers] = useState(defaultReviewers);
  const [useStrictPolicy, setUseStrictPolicy] = useState(true);
  const [postComment, setPostComment] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function selectMode(nextMode) {
    setMode(nextMode);
    setResult(null);
    setError("");
  }

  function toggleReviewer(key) {
    setSelectedReviewers((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
    setResult(null);
    setError("");
  }

  async function convene(event) {
    event.preventDefault();
    if (mode === "diff" && !diff.trim()) return setError("Paste a git diff before convening the review.");
    if (mode === "mr" && !mrUrl.trim()) return setError("Enter a GitLab merge request URL before convening the review.");
    if (!selectedReviewers.length) return setError("Select at least one reviewer before convening the review.");
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const commonPayload = {
        reviewers: selectedReviewers,
        ...(useStrictPolicy ? { policy: strictPolicy } : {}),
      };
      const payload = mode === "diff"
        ? { diff, ...commonPayload }
        : { url: mrUrl, post_comment: postComment, ...commonPayload };
      const response = await fetch(mode === "diff" ? API_URL : MR_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Review failed with status ${response.status}.`);
      setResult(body);
    } catch (requestError) {
      setError(requestError.message === "Failed to fetch"
        ? "Could not reach the review server. Check that it is running on port 3001."
        : requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="masthead">
        <div className="seal" aria-hidden="true">PR</div>
        <div><p className="kicker">Multi-agent code review</p><h1>PR Docket</h1></div>
        <p className="case-number">DOCKET № 004</p>
      </header>

      <section className="intro">
        <p className="eyebrow">Matter before the court</p>
        <h2>Submit a change for review.</h2>
        <p>Paste a focused diff or summon an entire GitLab merge request. Three specialists examine the evidence before the judge rules.</p>
      </section>

      <form className="submission" onSubmit={convene}>
        <div className="mode-tabs" role="tablist" aria-label="Review source">
          <button type="button" role="tab" aria-selected={mode === "diff"} className={mode === "diff" ? "active" : ""} onClick={() => selectMode("diff")}>Paste diff</button>
          <button type="button" role="tab" aria-selected={mode === "mr"} className={mode === "mr" ? "active" : ""} onClick={() => selectMode("mr")}>GitLab merge request</button>
        </div>
        {mode === "diff" ? <>
          <label htmlFor="diff">Git diff <span>— evidence entered into record</span></label>
          <textarea id="diff" value={diff} onChange={(event) => setDiff(event.target.value)} spellCheck="false" />
        </> : <div className="mr-entry">
          <label htmlFor="mr-url">Merge request URL <span>— public or server-authorized private project</span></label>
          <input id="mr-url" type="url" value={mrUrl} onChange={(event) => setMrUrl(event.target.value)} placeholder="https://gitlab.com/group/project/-/merge_requests/42" />
          <p>The docket fetches changed files from GitLab and reviews larger submissions in bounded batches.</p>
        </div>}
        <fieldset className="review-controls">
          <legend>Review panel</legend>
          <div className="reviewer-options">
            {reviewerOptions.map((reviewer) => <label key={reviewer.key} className={selectedReviewers.includes(reviewer.key) ? "checked" : ""}>
              <input type="checkbox" checked={selectedReviewers.includes(reviewer.key)} onChange={() => toggleReviewer(reviewer.key)} />
              <span aria-hidden="true">{reviewer.icon}</span>
              {reviewer.name}
            </label>)}
          </div>
          <div className="review-toggles">
            <label>
              <input type="checkbox" checked={useStrictPolicy} onChange={(event) => setUseStrictPolicy(event.target.checked)} />
              Strict team policy
            </label>
            {mode === "mr" && <label>
              <input type="checkbox" checked={postComment} onChange={(event) => setPostComment(event.target.checked)} />
              Post GitLab comment
            </label>}
          </div>
        </fieldset>
        <div className="form-footer">
          <span>{mode === "diff" ? `${diff.split("\n").length} lines submitted` : "GitLab API submission"}</span>
          <button type="submit" disabled={loading}>{loading ? "Reviewers reading diff..." : "Convene review"}</button>
        </div>
      </form>

      {error && <div className="error" role="alert"><strong>Review interrupted.</strong> {error}</div>}

      {result && <section className="results" aria-live="polite">
        {result.merge_request && <div className="mr-summary">
          <p className="eyebrow">GitLab merge request</p>
          <h2>{result.merge_request.title}</h2>
          <p><code>{result.merge_request.source_branch}</code> into <code>{result.merge_request.target_branch}</code> · {result.merge_request.reviewed_file_count} of {result.merge_request.file_count} files reviewed in {result.batch_count} batch{result.batch_count === 1 ? "" : "es"}</p>
          {result.merge_request.skipped_file_count > 0 && <p className="skip-warning">{result.merge_request.skipped_file_count} file(s) were skipped because of GitLab or review-size limits.</p>}
          <a href={result.merge_request.web_url} target="_blank" rel="noreferrer">Open in GitLab</a>
        </div>}
        {result.reviewer_keys?.length > 0 && <p className="active-reviewers">Active reviewers: {result.reviewer_keys.map((key) => meta[key]?.name || key).join(", ")}</p>}
        <div className="section-heading"><p className="eyebrow">Specialist findings</p><h2>Opinions entered</h2></div>
        <div className="reviewer-grid">
          {result.reviewers.map((reviewer, index) => <ReviewerCard key={reviewer.key} reviewer={reviewer} index={index} />)}
        </div>
        <DebateCard debate={result.debate} />
        <CiGate ci={result.ci} />
        <article className="judge-card">
          <div className="judge-heading"><div className="gavel" aria-hidden="true">⚖</div><div><p className="eyebrow">Presiding agent</p><h2>Judge’s verdict</h2></div></div>
          <span className="judge-verdict">{label(result.judge.verdict)}</span>
          <p className="rationale">{result.judge.rationale}</p>
          <dl>
            <div><dt>Reviewers</dt><dd>{result.judge.reviewer_count}</dd></div>
            <div><dt>Blocking</dt><dd>{result.judge.blocking_count}</dd></div>
            <div><dt>Suggestions</dt><dd>{result.judge.suggestion_count}</dd></div>
          </dl>
        </article>
        <FixSuggestions suggestions={result.fix_suggestions} />
      </section>}
    </main>
  );
}

export default App;
