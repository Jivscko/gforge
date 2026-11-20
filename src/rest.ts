// The REST v3 surface under /api/v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, their files and merges. Every reply is JSON with a string message on
// errors; statuses follow GitHub's (201 create, 200 update, 409 stale sha, 422 validation,
// 404 unknown, 405 unmergeable, 204 delete). Ownership: a repository belongs to the token's login;
// the same name under any other owner is a 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, EMPTY_TREE, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './identity.ts';
import type { CommitView } from './git.ts';
import { parseJsonBody, readBody, sendEmpty, sendJson } from './http.ts';

export interface RestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

const API_ROOT = {
  current_user_url: '/api/v3/user',
  current_user_authorizations_html_url: '/api/v3/settings/connections/applications{/client_id}',
  repository_url: '/api/v3/repos/{owner}/{repo}',
  rate_limit_url: '/api/v3/rate_limit',
  user_url: '/api/v3/users/{user}',
};

/** Entry point: route one /api/v3 request. Throws ApiError for the caller to render. */
export async function handleRest(ctx: RestContext): Promise<void> {
  if (!ctx.authed) throw new ApiError(401, 'Requires authentication');
  const segments = ctx.url.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeURIComponent(s));
  const method = ctx.req.method ?? 'GET';
  const store = ctx.store;

  if (segments.length === 0) {
    sendJson(ctx.res, 200, API_ROOT, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo' });
    return;
  }
  const [head, ...rest] = segments;

  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    sendJson(ctx.res, 200, { verifiable_password_authentication: false, installed_version: 'gforge/1.0.0' });
    return;
  }
  if (head === 'rate_limit' && method === 'GET') {
    sendJson(ctx.res, 200, { resources: {}, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } });
    return;
  }
  if (head === 'user') {
    if (rest.length === 0 && method === 'GET') {
      sendJson(ctx.res, 200, userJson());
      return;
    }
    if (rest.length === 1 && rest[0] === 'repos') {
      if (method === 'GET') return listUserRepos(ctx);
      if (method === 'POST') return createUserRepo(ctx);
    }
  }
  if (head === 'repos' && rest.length >= 2) {
    const repo = store.getRepo(rest[0]!, rest[1]!);
    const sub = rest.slice(2);
    return repoRoute(ctx, repo, sub, method);
  }
  throw new ApiError(404, 'Not Found');
}

// ---------------------------------------------------------------- serializers

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: 1,
    node_id: 'U_gforge1',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_gforge${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `L_gforge${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    id: issue.id,
    node_id: `I_gforge${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { id: 0, name, color: 'ededed', description: '' })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullRefJson(repo: Repo, ref: { ref: string; sha: string }): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref.ref}`,
    ref: ref.ref,
    sha: ref.sha,
    user: userJson(),
    repo: repoJson(repo),
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? store.mergeableState(repo, pull) : 'UNKNOWN';
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    id: pull.id,
    node_id: `PR_gforge${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: pullRefJson(repo, pull.head),
    base: pullRefJson(repo, pull.base),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? mergeable === 'MERGEABLE' : null,
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    author_association: 'OWNER',
    draft: false,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    id: comment.id,
    node_id: `IC_gforge${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

/** Split a git identity line `Name <email> 1234567890 +0000` into its parts. */
function identityParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})?$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  const epoch = Number(match[3]);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(epoch * 1000).toISOString() };
}

function commitJson(repo: Repo, oid: string, view: CommitView): Record<string, unknown> {
  const author = identityParts(view.author);
  const committer = identityParts(view.committer);
  return {
    sha: oid,
    node_id: `C_gforge${oid}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: view.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}` })),
  };
}

// ---------------------------------------------------------------- pagination

function pageParams(ctx: RestContext): { page: number; perPage: number } {
  const perRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perRaw) ? Math.min(100, Math.max(1, Math.trunc(perRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { page, perPage };
}

/** Slice one page and set the Link header (absolute, on the request's own origin). */
function sendPage<T>(ctx: RestContext, items: readonly T[], serialize: (item: T) => unknown): void {
  const { page, perPage } = pageParams(ctx);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage).map(serialize);
  const headers: Record<string, string> = {};
  if (lastPage > 1) {
    const host = ctx.req.headers.host ?? 'localhost';
    const link = (target: number, rel: string): string => {
      const url = new URL(ctx.url.pathname, `http://${host}`);
      for (const [key, value] of ctx.url.searchParams) if (key !== 'page') url.searchParams.set(key, value);
      url.searchParams.set('page', String(target));
      return `<${url.toString()}>; rel="${rel}"`;
    };
    const parts: string[] = [];
    if (page < lastPage) parts.push(link(page + 1, 'next'), link(lastPage, 'last'));
    if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
    if (parts.length > 0) headers.link = parts.join(', ');
  }
  sendJson(ctx.res, 200, slice, headers);
}

// ---------------------------------------------------------------- /user/repos

function listUserRepos(ctx: RestContext): void {
  const repos = ctx.store.listRepos();
  sendPage(ctx, repos, repoJson);
}

async function createUserRepo(ctx: RestContext): Promise<void> {
  const raw = await readBody(ctx.req);
  if (raw === null) throw new ApiError(413, 'Body too large');
  const body = parseJsonBody(raw);
  const repo = ctx.store.createRepo({
    name: body.name as string,
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
    autoInit: body.auto_init === true,
  });
  sendJson(ctx.res, 201, repoJson(repo));
}

// ---------------------------------------------------------------- /repos/{o}/{r}/...

async function repoRoute(ctx: RestContext, repo: Repo, sub: string[], method: string): Promise<void> {
  const store = ctx.store;
  if (sub.length === 0) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        const key = store.repoKey(repo.owner, repo.name);
        store.repos.delete(key);
        repo.name = body.name;
        store.repos.set(store.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body.default_branch === 'string' && store.branchSha(repo, body.default_branch) !== undefined) {
        repo.defaultBranch = body.default_branch;
      }
      repo.updatedAt = store.tick();
      sendJson(ctx.res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendEmpty(ctx.res, 204);
      return;
    }
  }
  if (sub[0] === 'branches') {
    if (sub.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(ctx.res, 200, branches);
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const sha = store.branchSha(repo, sub[1]!);
      if (sha === undefined) throw new ApiError(404, 'Branch not found');
      sendJson(ctx.res, 200, { name: sub[1], commit: commitJson(repo, sha, store.commitView(sha)), protected: false });
      return;
    }
  }
  if (sub[0] === 'commits') {
    if (sub.length === 1 && method === 'GET') {
      const ref = ctx.url.searchParams.get('sha') ?? undefined;
      const commits = store.listCommits(repo, ref);
      const { page, perPage } = pageParams(ctx);
      sendJson(ctx.res, 200, commits.slice((page - 1) * perPage, page * perPage).map((entry) => commitJson(repo, entry.oid, entry.commit)));
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const oid = store.resolveCommit(repo, sub[1]);
      if (oid === null) throw new ApiError(404, 'Not Found');
      sendJson(ctx.res, 200, commitJson(repo, oid, store.commitView(oid)));
      return;
    }
  }
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (sub.length === 2 && method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const created = store.createRef(repo, body.ref as string, body.sha as string);
      sendJson(ctx.res, 201, {
        ref: created.ref,
        node_id: `REF_gforge${created.ref}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${created.ref}`,
        object: { sha: created.sha, type: created.type, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${created.type}s/${created.sha}` },
      });
      return;
    }
    if (sub.length >= 3 && method === 'GET') {
      const refName = `refs/${sub.slice(2).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) throw new ApiError(404, 'Not Found');
      const object = store.objects.get(sha);
      sendJson(ctx.res, 200, {
        ref: refName,
        node_id: `REF_gforge${refName}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}`,
        object: { sha, type: object?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${object?.type ?? 'commit'}s/${sha}` },
      });
      return;
    }
  }
  if (sub[0] === 'contents' && sub.length >= 2) {
    const path = sub.slice(1).join('/');
    return contentsRoute(ctx, repo, path, method);
  }
  if (sub[0] === 'labels') {
    if (sub.length === 1 && method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const label = store.createLabel(repo, { name: body.name as string, color: body.color as string | undefined, description: body.description as string | undefined });
      sendJson(ctx.res, 201, labelJson(label));
      return;
    }
    if (sub.length === 1 && method === 'GET') {
      sendJson(ctx.res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
  }
  if (sub[0] === 'issues') {
    return issuesRoute(ctx, repo, sub.slice(1), method);
  }
  if (sub[0] === 'pulls') {
    return pullsRoute(ctx, repo, sub.slice(1), method);
  }
  throw new ApiError(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

async function contentsRoute(ctx: RestContext, repo: Repo, path: string, method: string): Promise<void> {
  const store = ctx.store;
  if (method === 'GET') {
    const ref = ctx.url.searchParams.get('ref') ?? undefined;
    const content = store.getContent(repo, path, ref);
    if (content === null) throw new ApiError(404, 'Not Found');
    if (content.kind === 'dir') {
      sendJson(
        ctx.res,
        200,
        content.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: entry.type === 'file' ? (store.objects.get(entry.sha)?.data.length ?? 0) : 0,
          type: entry.type,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
        })),
      );
      return;
    }
    sendJson(ctx.res, 200, fileJson(store, repo, path, content.oid));
    return;
  }
  if (method === 'PUT') {
    const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
    if (typeof body.message !== 'string') throw new ApiError(422, 'message is required');
    if (typeof body.content !== 'string') throw new ApiError(422, 'content is required');
    const content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const result = store.commitFile(repo, {
      path,
      content,
      message: body.message,
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      sha: typeof body.sha === 'string' ? body.sha : undefined,
    });
    const view = store.commitView(result.commitSha);
    sendJson(ctx.res, result.created ? 201 : 200, {
      content: fileJson(store, repo, path, result.blobSha),
      commit: commitJson(repo, result.commitSha, view),
    });
    return;
  }
  if (method === 'DELETE') {
    const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
    if (typeof body.message !== 'string') throw new ApiError(422, 'message is required');
    const result = store.deleteFile(repo, {
      path,
      message: body.message,
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      sha: typeof body.sha === 'string' ? body.sha : undefined,
    });
    sendJson(ctx.res, 200, { content: null, commit: commitJson(repo, result.commitSha, store.commitView(result.commitSha)) });
    return;
  }
  throw new ApiError(404, 'Not Found');
}

function fileJson(store: Store, repo: Repo, path: string, oid: string): Record<string, unknown> {
  const blob = store.objects.get(oid)?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  const base64 = blob.toString('base64');
  const wrapped = base64.replace(/(.{60})/g, '$1\n');
  return {
    name,
    path,
    sha: oid,
    size: blob.length,
    type: 'file',
    encoding: 'base64',
    content: wrapped,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

// ---------------------------------------------------------------- issues

async function issuesRoute(ctx: RestContext, repo: Repo, sub: string[], method: string): Promise<void> {
  const store = ctx.store;
  if (sub.length === 0) {
    if (method === 'GET') {
      const query = {
        state: ctx.url.searchParams.get('state') ?? undefined,
        sort: ctx.url.searchParams.get('sort') ?? undefined,
        direction: ctx.url.searchParams.get('direction') ?? undefined,
        labels: ctx.url.searchParams.get('labels') ?? undefined,
      };
      const issues = store.listIssues(repo, query);
      sendPage(ctx, issues, (issue) => issueJson(repo, issue));
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const issue = store.createIssue(repo, {
        title: body.title as string,
        body: typeof body.body === 'string' ? body.body : '',
        labels: Array.isArray(body.labels) ? (body.labels as string[]) : [],
      });
      sendJson(ctx.res, 201, issueJson(repo, issue));
      return;
    }
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number <= 0) throw new ApiError(404, 'Not Found');
  if (sub.length === 1) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, issueJson(repo, store.getIssue(repo, number)));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const issue = store.patchIssue(repo, number, {
        state: typeof body.state === 'string' ? body.state : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
        labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
      });
      sendJson(ctx.res, 200, issueJson(repo, issue));
      return;
    }
  }
  if (sub.length === 2 && sub[1] === 'comments') {
    const issue = store.getIssue(repo, number);
    if (method === 'GET') {
      sendJson(ctx.res, 200, issue.comments.map((comment) => commentJson(repo, number, comment)));
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const comment = store.addComment(repo, number, body.body as string);
      sendJson(ctx.res, 201, commentJson(repo, number, comment));
      return;
    }
  }
  throw new ApiError(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

async function pullsRoute(ctx: RestContext, repo: Repo, sub: string[], method: string): Promise<void> {
  const store = ctx.store;
  if (sub.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const pulls = store.listPulls(repo, state);
      sendPage(ctx, pulls, (pull) => pullJson(store, repo, pull));
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const pull = store.createPull(repo, {
        title: body.title as string,
        body: typeof body.body === 'string' ? body.body : '',
        head: body.head as string,
        base: body.base as string,
      });
      sendJson(ctx.res, 201, pullJson(store, repo, pull));
      return;
    }
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number <= 0) throw new ApiError(404, 'Not Found');
  if (sub.length === 1) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, pullJson(store, repo, store.getPull(repo, number)));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
      const pull = store.getPull(repo, number);
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.updatedAt = store.tick();
      } else if (body.state === 'open' && !pull.merged) {
        pull.state = 'open';
        pull.updatedAt = store.tick();
      }
      sendJson(ctx.res, 200, pullJson(store, repo, pull));
      return;
    }
  }
  if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
    const pull = store.getPull(repo, number);
    const files = store.pullFiles(repo, pull);
    sendJson(
      ctx.res,
      200,
      files.map((file) => ({
        sha: EMPTY_TREE,
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
        patch: '',
      })),
    );
    return;
  }
  if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
    const body = parseJsonBody((await readBody(ctx.req)) ?? Buffer.alloc(0));
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const result = store.mergePull(
      repo,
      number,
      mergeMethod,
      typeof body.commit_title === 'string' ? body.commit_title : undefined,
      typeof body.commit_message === 'string' ? body.commit_message : undefined,
    );
    sendJson(ctx.res, 200, result);
    return;
  }
  if (sub.length === 2 && sub[1] === 'commits' && method === 'GET') {
    const pull = store.getPull(repo, number);
    const headTip = store.branchSha(repo, pull.head.ref) ?? pull.head.sha;
    const commits = store.listCommits(repo, headTip);
    sendJson(ctx.res, 200, commits.map((entry) => commitJson(repo, entry.oid, entry.commit)));
    return;
  }
  throw new ApiError(404, 'Not Found');
}
