# PR Docket

PR Docket is a stateless, multi-agent code review demo. Paste a small git diff or provide a GitLab merge request URL. Three Qwen-powered specialists review security, performance, and readability in parallel, then a fourth judge agent weighs their findings.

## Run locally

Use Node.js 18 or newer. Start the API in one terminal:

```bash
cd server
npm install
cp .env.example .env
# Add your QWEN_API_KEY to .env
npm run dev
```

Then start the React app in another terminal:

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:3001`; its health endpoint is `GET /health`.

## Qwen Cloud setup

Create an account in the [Alibaba Cloud Model Studio console](https://modelstudio.console.alibabacloud.com/), enable the international DashScope service, and create an API key. Copy `server/.env.example` to `server/.env` and set:

```env
QWEN_API_KEY=your_key_here
PORT=3001
GITLAB_TOKEN=
GITLAB_URL=https://gitlab.com
```

Never commit the `.env` file. The server uses the official `openai` npm client with Qwen's OpenAI-compatible international endpoint. To point the frontend elsewhere, create `client/.env` with `VITE_REVIEW_API_URL=https://your-api.example/api/review`.

## GitLab merge requests

Public GitLab.com projects work without additional credentials. For private projects, create a GitLab project or personal access token with `read_api` scope and set `GITLAB_TOKEN` in `server/.env`. For a self-managed instance, set `GITLAB_URL` to its origin; submitted MR URLs are restricted to that origin to prevent arbitrary server-side requests.

The server uses GitLab's supported `GET /projects/:id/merge_requests/:iid/diffs` endpoint, groups files into bounded batches, aggregates each specialist's findings, and sends the combined three-reviewer result to the judge. GitLab and model context limits can cause very large or binary files to be skipped; the UI reports the reviewed and skipped file counts.

## Scope

This hackathon version keeps no database, user accounts, or webhook automation. In production, a GitLab webhook could trigger the same merge-request review pipeline when an MR is opened or synchronized.

## Improvement roadmap

These are the highest-impact improvements for turning PR Docket from a hackathon demo into a stronger product and a more competitive submission.

### Innovation and AI creativity

- Add evidence-based findings instead of plain issue strings. Each Qwen reviewer should return `file`, `line_hint`, `evidence`, `risk`, `confidence`, and `recommendation` so every claim is traceable to the diff.
- Add custom reviewer profiles such as `frontend`, `backend`, `database`, `testing`, `cloud-cost`, and `accessibility` instead of only security, performance, and readability.
- Add a repo policy file such as `.prdocket.yml` so teams can define required reviewers, forbidden patterns, required test coverage rules, and project-specific review standards.
- Add a reviewer debate step where Qwen compares conflicting findings, removes weak claims, and sends a cleaner set of findings to the judge agent.
- Add patch suggestions in unified diff format for blocking issues so the tool can move from review-only to review-and-fix assistance.

### Technical depth and engineering

- Replace free-form issue strings with a structured issue schema that is easier to validate, render, test, and post back to GitLab.
- Add request validation for `/api/review` and `/api/review-mr`, including body shape, content type, MR URL format, and maximum diff size.
- Add rate limiting and concurrency limits to protect Qwen quota and keep the deployed backend stable under public access.
- Add token and cost controls by estimating diff size before calling Qwen, capping batches, and reporting skipped files with explicit reasons.
- Add structured logs with request id, review type, batch count, Qwen latency, GitLab latency, and error category.
- Add tests for GitLab URL parsing, diff batching, malformed Qwen JSON fallback, missing API key handling, empty diff handling, and large diff rejection.
- Add a CI-oriented response mode with `passed`, `blocking_count`, and `max_severity` so the result can gate pull requests automatically.
- Add Docker health checks and a `/ready` endpoint that verifies required runtime configuration such as `QWEN_API_KEY`.

### Problem value and product direction

- Position PR Docket as AI code-review triage: it catches obvious risks before human review and helps senior reviewers spend time on the hardest decisions.
- Add GitLab MR comment posting so the backend can publish the judge verdict and top findings directly into the merge request.
- Add a human-review handoff summary with the top blockers, files needing attention, and suggested reviewer expertise.
- Add confidence levels so teams can distinguish directly evidenced findings from items that need human verification.
- Keep the product self-hostable for private codebases, with all secrets provided through environment variables.

### Presentation and documentation

- Add an architecture diagram showing the flow from pasted diff or GitLab MR URL to Qwen specialist reviewers, judge agent, and structured verdict.
- Add API examples for `GET /health`, `POST /api/review`, and `POST /api/review-mr` with sample request and response bodies.
- Add a demo script with a known vulnerable diff and the expected security, performance, readability, and judge outputs.
- Add a judging-alignment section that maps the implementation to innovation, technical depth, problem impact, and documentation criteria.
- Add limitations clearly: Qwen can miss context outside the diff, large diffs may be truncated, private GitLab projects require a token, and AI review does not replace human approval.

The strongest next milestone is to make PR Docket a GitLab AI review bot: submit an MR URL, run the Qwen specialist review pipeline, and post a structured judge summary back to the MR as a comment.

## Alibaba Cloud deployment

The backend is packaged for Alibaba Cloud ECS in `server/Dockerfile`. Follow the step-by-step [Alibaba ECS deployment runbook](deploy/alibaba-ecs.md). The container reads Qwen and GitLab credentials only from environment variables and exposes the `/health` endpoint for deployment proof.
