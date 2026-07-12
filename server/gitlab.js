const DEFAULT_GITLAB_URL = "https://gitlab.com";
const PER_PAGE = 100;
const MAX_PAGES = 5;
const MAX_DIFF_CHARACTERS = 180_000;

export function parseMergeRequestUrl(value, configuredBaseUrl = DEFAULT_GITLAB_URL) {
  let url;
  let baseUrl;
  try {
    url = new URL(value);
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new Error("Enter a valid GitLab merge request URL.");
  }
  if (url.origin !== baseUrl.origin) throw new Error(`Merge request URLs must belong to ${baseUrl.origin}.`);
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match) throw new Error("Use a GitLab URL ending in /-/merge_requests/<number>.");
  return { projectPath: decodeURIComponent(match[1]), iid: Number(match[2]), baseUrl: baseUrl.origin };
}

async function gitlabRequest(url, token, options = {}) {
  const headers = token ? { "PRIVATE-TOKEN": token } : {};
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error("GitLab denied access. Check GITLAB_TOKEN for this project.");
    if (response.status === 404) throw new Error("The merge request was not found or is not accessible.");
    throw new Error(`GitLab returned status ${response.status}.`);
  }
  return response.json();
}

export async function fetchMergeRequest(mrUrl, options = {}) {
  const parsed = parseMergeRequestUrl(mrUrl, options.baseUrl);
  const apiRoot = `${parsed.baseUrl}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${parsed.iid}`;
  const details = await gitlabRequest(apiRoot, options.token);
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageFiles = await gitlabRequest(`${apiRoot}/diffs?per_page=${PER_PAGE}&page=${page}`, options.token);
    files.push(...pageFiles);
    if (pageFiles.length < PER_PAGE) break;
  }

  const reviewable = files.filter((file) => file.diff && !file.too_large);
  if (!reviewable.length) throw new Error("This merge request has no reviewable text diffs.");
  let usedCharacters = 0;
  const diffs = [];
  for (const file of reviewable) {
    const entry = `diff --git a/${file.old_path} b/${file.new_path}\n--- a/${file.old_path}\n+++ b/${file.new_path}\n${file.diff}`;
    if (usedCharacters + entry.length > MAX_DIFF_CHARACTERS) break;
    diffs.push(entry);
    usedCharacters += entry.length;
  }
  if (!diffs.length) throw new Error("The merge request diff is too large to review safely.");
  return {
    title: details.title,
    web_url: details.web_url,
    source_branch: details.source_branch,
    target_branch: details.target_branch,
    files: diffs,
    file_count: files.length,
    reviewed_file_count: diffs.length,
    skipped_file_count: files.length - diffs.length,
  };
}

export async function postMergeRequestNote(mrUrl, body, options = {}) {
  if (!options.token) throw new Error("GITLAB_TOKEN is required to post a merge request comment.");
  if (typeof body !== "string" || !body.trim()) throw new Error("A non-empty comment body is required.");

  const parsed = parseMergeRequestUrl(mrUrl, options.baseUrl);
  const apiRoot = `${parsed.baseUrl}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${parsed.iid}`;
  const note = await gitlabRequest(`${apiRoot}/notes`, options.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });

  return {
    posted_to_gitlab: true,
    comment_url: note.web_url || null,
    note_id: note.id,
  };
}
