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
