import assert from "node:assert/strict";
import test from "node:test";
import { parseMergeRequestUrl } from "./gitlab.js";
import { batchDiffs } from "./reviewers.js";

test("parses a nested GitLab merge request URL", () => {
  assert.deepEqual(parseMergeRequestUrl("https://gitlab.com/acme/platform/api/-/merge_requests/42"), {
    projectPath: "acme/platform/api",
    iid: 42,
    baseUrl: "https://gitlab.com",
  });
});

test("rejects a merge request URL from another origin", () => {
  assert.throws(
    () => parseMergeRequestUrl("https://example.com/acme/app/-/merge_requests/1"),
    /must belong/,
  );
});

test("supports a configured self-managed GitLab origin", () => {
  const result = parseMergeRequestUrl(
    "https://gitlab.internal.example/acme/app/-/merge_requests/7",
    "https://gitlab.internal.example",
  );
  assert.equal(result.projectPath, "acme/app");
  assert.equal(result.iid, 7);
});

test("batches complete file diffs when they fit", () => {
  assert.deepEqual(batchDiffs(["1234", "5678", "90"], 10), ["1234\n\n5678", "90"]);
});

test("isolates and truncates a file larger than the batch limit", () => {
  assert.deepEqual(batchDiffs(["small", "123456789"], 5), ["small", "12345"]);
});
