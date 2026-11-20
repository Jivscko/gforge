// The in-memory forge: one global content-addressed object store, repositories with refs, issues,
// pull requests, labels and comments. Every surface (REST, git smart HTTP, GraphQL, MCP) acts on
// this one store, so an object created anywhere reads back everywhere with the same id. Nothing is
// persisted; the process is the database. Timestamps come from a logical clock seeded by
// MAKEFUN_TRIAL_NOW (never the wall clock), so two runs on the same inputs produce the same bytes.

import {
  type GitObject,
  type GitObjectType,
  type CommitView,
  buildCommit,
  buildTree,
  diffTrees,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTag,
  parseTree,
  peel,
  treePathBlob,
  treePathDir,
  treeWithFile,
  type FileChange,
} from './git.ts';
import { COMMITTER, VIEWER } from './identity.ts';

/** An error that maps straight onto an HTTP status and a JSON {message} body. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
  updatedSeq: number;
  closedAt: string | null;
  readonly comments: Comment[];
}

export interface PullRef {
  ref: string;
  sha: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: PullRef;
  base: PullRef;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
}

/** The empty tree, the base a root commit's diff is taken against. */
export const EMPTY_TREE = hashObject('tree', Buffer.alloc(0));

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private seq = 0;
  private clockMs: number;
  private readonly connectedSet = new Set<string>();

  constructor() {
    const now = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
    this.clockMs = Number.isFinite(now) ? now : 1_735_689_600_000;
    this.objects.set(EMPTY_TREE, { type: 'tree', data: Buffer.alloc(0) });
  }

  /** The logical clock: one millisecond per event, ISO strings for the API, seconds for commits. */
  tick(): string {
    this.clockMs += 1;
    this.seq += 1;
    return new Date(this.clockMs).toISOString();
  }

  commitTimestamp(): number {
    this.clockMs += 1;
    this.seq += 1;
    return Math.floor(this.clockMs / 1000);
  }

  get lookup(): (oid: string) => GitObject | undefined {
    return (oid) => this.objects.get(oid);
  }

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  // ---------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(input: { name: string; description?: string; private?: boolean; autoInit?: boolean }): Repo {
    const name = input.name;
    if (typeof name !== 'string' || !REPO_NAME.test(name) || name === '.' || name === '..') {
      throw new ApiError(422, 'Repository creation failed: name is invalid');
    }
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) throw new ApiError(422, 'Repository creation failed: name already exists on this account');
    const now = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    if (input.autoInit === true) {
      const blob = this.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
      const tree = this.put('tree', buildTree([{ mode: '100644', name: 'README.md', oid: blob }]));
      const commit = this.put(
        'commit',
        buildCommit({ tree, message: 'Initial commit\n', author: COMMITTER, timestamp: this.commitTimestamp() }),
      );
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
    }
    return repo;
  }

  /** A repository of the token's login; any other owner is a 404, never a 403. */
  getRepo(owner: string, name: string): Repo {
    if (owner !== VIEWER.login) throw new ApiError(404, 'Not Found');
    const repo = this.repos.get(this.repoKey(owner, name));
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.getRepo(owner, name);
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // ---------------------------------------------------------------- refs and commits

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchSha(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a branch name, a full ref name or a raw oid to a commit oid. */
  resolveCommit(repo: Repo, ref: string | undefined): string | null {
    const name = ref === undefined || ref === '' ? repo.defaultBranch : ref;
    const direct = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`);
    if (direct !== undefined) return peel(direct, this.lookup);
    if (isObjectId(name) && this.objects.has(name)) return name;
    return null;
  }

  commitView(oid: string): CommitView {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') throw new ApiError(404, 'Not Found');
    return parseCommit(object.data);
  }

  createRef(repo: Repo, ref: string, sha: string): { ref: string; sha: string; type: string } {
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new ApiError(422, 'Reference must be a fully qualified name (refs/...)');
    if (!isObjectId(sha)) throw new ApiError(422, 'Invalid object id');
    const object = this.objects.get(sha);
    if (!object) throw new ApiError(422, 'Object does not exist');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.updatedAt = this.tick();
    return { ref, sha, type: object.type };
  }

  /** The first-parent chain from a ref, newest first. */
  listCommits(repo: Repo, ref: string | undefined): Array<{ oid: string; commit: CommitView }> {
    const tip = this.resolveCommit(repo, ref);
    if (tip === null) {
      if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty');
      throw new ApiError(404, 'Not Found');
    }
    const out: Array<{ oid: string; commit: CommitView }> = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const object = this.objects.get(current);
      if (!object || object.type !== 'commit') break;
      const commit = parseCommit(object.data);
      out.push({ oid: current, commit });
      current = commit.parents[0] ?? null;
    }
    return out;
  }

  // ---------------------------------------------------------------- contents

  commitFile(
    repo: Repo,
    input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; blobSha: string; created: boolean } {
    const path = input.path.replace(/^\/+/, '');
    if (path === '' || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new ApiError(422, 'Invalid path');
    }
    const branch = input.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref) ?? null;
    if (parent === null && branch !== repo.defaultBranch) {
      // A contents write on a new branch forks the default branch's tip.
      parent = repo.refs.get(this.headRef(repo)) ?? null;
    }
    const parentTree = parent === null ? null : this.commitView(parent).tree;
    const existing = parentTree === null ? null : treePathBlob(parentTree, path, this.lookup);
    let created: boolean;
    if (existing !== null) {
      if (input.sha === undefined) throw new ApiError(422, 'sha wasn\'t supplied');
      if (input.sha.toLowerCase() !== existing) throw new ApiError(409, 'The supplied sha does not match the current file');
      created = false;
    } else {
      if (input.sha !== undefined) throw new ApiError(409, 'The supplied sha does not match the current file');
      created = true;
    }
    const blobSha = this.put('blob', input.content);
    const tree = treeWithFile(parentTree, path, blobSha, this.lookup, (t, d) => this.put(t, d));
    const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
    const commitSha = this.put(
      'commit',
      buildCommit({
        tree,
        parents: parent === null ? [] : [parent],
        message,
        author: COMMITTER,
        timestamp: this.commitTimestamp(),
      }),
    );
    repo.refs.set(ref, commitSha);
    repo.updatedAt = this.tick();
    return { commitSha, blobSha, created };
  }

  deleteFile(repo: Repo, input: { path: string; message: string; branch?: string; sha?: string }): { commitSha: string } {
    const path = input.path.replace(/^\/+/, '');
    const branch = input.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref) ?? null;
    if (parent === null) throw new ApiError(404, 'Not Found');
    const parentTree = this.commitView(parent).tree;
    const existing = treePathBlob(parentTree, path, this.lookup);
    if (existing === null) throw new ApiError(404, 'Not Found');
    if (input.sha !== undefined && input.sha.toLowerCase() !== existing) {
      throw new ApiError(409, 'The supplied sha does not match the current file');
    }
    const tree = treeWithFile(parentTree, path, null, this.lookup, (t, d) => this.put(t, d));
    const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
    const commitSha = this.put(
      'commit',
      buildCommit({ tree, parents: [parent], message, author: COMMITTER, timestamp: this.commitTimestamp() }),
    );
    repo.refs.set(ref, commitSha);
    repo.updatedAt = this.tick();
    return { commitSha };
  }

  /** A file's blob, or a directory's entries, at a ref. Null when the path is absent. */
  getContent(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; oid: string } | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> } | null {
    const tip = this.resolveCommit(repo, ref);
    if (tip === null) return null;
    const object = this.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const rootTree = parseCommit(object.data).tree;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      return { kind: 'dir', entries: this.dirEntries(repo, rootTree, '') };
    }
    const blob = treePathBlob(rootTree, clean, this.lookup);
    if (blob !== null) return { kind: 'file', oid: blob };
    const dir = treePathDir(rootTree, clean, this.lookup);
    if (dir !== null) return { kind: 'dir', entries: this.dirEntries(repo, dir, clean) };
    return null;
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  // ---------------------------------------------------------------- labels, issues, comments

  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
    if (typeof input.name !== 'string' || input.name === '') throw new ApiError(422, 'Label name is required');
    if (repo.labels.has(input.name)) throw new ApiError(422, 'Label already exists');
    const label: Label = {
      id: this.nextLabelId++,
      name: input.name,
      color: (input.color ?? 'ededed').replace(/^#/, ''),
      description: input.description ?? '',
    };
    repo.labels.set(label.name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): Issue {
    if (typeof input.title !== 'string' || input.title === '') throw new ApiError(422, 'Title is required');
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ApiError(422, `Label '${name}' does not exist`);
    }
    const now = this.tick();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      createdSeq: this.seq,
      updatedSeq: this.seq,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    repo.updatedAt = now;
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new ApiError(404, 'Not Found');
    return issue;
  }

  patchIssue(repo: Repo, number: number, input: { state?: string; title?: string; body?: string; labels?: readonly string[] }): Issue {
    const issue = this.getIssue(repo, number);
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    if (input.labels !== undefined) {
      for (const name of input.labels) {
        if (!repo.labels.has(name)) throw new ApiError(422, `Label '${name}' does not exist`);
      }
      issue.labels = [...input.labels];
    }
    if (input.state !== undefined) {
      if (input.state !== 'open' && input.state !== 'closed') throw new ApiError(422, 'Invalid state');
      if (input.state === 'closed' && issue.state === 'open') issue.closedAt = this.tick();
      if (input.state === 'open') issue.closedAt = null;
      issue.state = input.state;
    }
    issue.updatedAt = this.tick();
    issue.updatedSeq = this.seq;
    return issue;
  }

  listIssues(
    repo: Repo,
    query: { state?: string; sort?: string; direction?: string; labels?: string },
  ): Issue[] {
    const state = query.state ?? 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    if (query.labels !== undefined && query.labels !== '') {
      const wanted = query.labels.split(',').map((s) => s.trim());
      issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
    }
    const sort = query.sort ?? 'created';
    const direction = query.direction === 'asc' ? 1 : -1;
    const key = (issue: Issue): number => {
      if (sort === 'updated') return issue.updatedSeq;
      if (sort === 'comments') return issue.comments.length;
      return issue.createdSeq;
    };
    issues.sort((a, b) => {
      const diff = key(a) - key(b);
      if (diff !== 0) return diff * direction;
      return (a.number - b.number) * direction;
    });
    return issues;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = this.getIssue(repo, number);
    if (typeof body !== 'string' || body === '') throw new ApiError(422, 'Comment body is required');
    const now = this.tick();
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.updatedAt = now;
    issue.updatedSeq = this.seq;
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  private branchName(value: string): string {
    // Accept a plain branch, refs/heads/x, or an owner:branch label.
    let name = value;
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
    if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
    return name;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull {
    if (typeof input.title !== 'string' || input.title === '') throw new ApiError(422, 'Title is required');
    const head = this.branchName(input.head ?? '');
    const base = this.branchName(input.base ?? '');
    const headSha = this.branchSha(repo, head);
    const baseSha = this.branchSha(repo, base);
    if (headSha === undefined) throw new ApiError(422, `head branch '${head}' does not exist`);
    if (baseSha === undefined) throw new ApiError(422, `base branch '${base}' does not exist`);
    if (head === base) throw new ApiError(422, 'head and base must be different branches');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head.ref === head && pull.base.ref === base) {
        throw new ApiError(422, 'A pull request already exists for this head and base');
      }
    }
    const now = this.tick();
    const pull: Pull = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      createdAt: now,
      updatedAt: now,
      createdSeq: this.seq,
    };
    repo.pulls.set(pull.number, pull);
    repo.updatedAt = now;
    return pull;
  }

  getPull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, 'Not Found');
    return pull;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    return pulls;
  }

  /** The changed files of a pull: merge-base(base, head) → head, at the branches' current tips. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = this.branchSha(repo, pull.head.ref) ?? pull.head.sha;
    const baseTip = this.branchSha(repo, pull.base.ref) ?? pull.base.sha;
    const base = mergeBase(baseTip, headTip, this.lookup);
    const baseTree = base === null ? EMPTY_TREE : this.commitView(base).tree;
    const headTree = this.commitView(headTip).tree;
    return diffTrees(baseTree, headTree, this.lookup);
  }

  /** Whether a pull's head merges cleanly into its base right now. */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
    const headTip = this.branchSha(repo, pull.head.ref);
    const baseTip = this.branchSha(repo, pull.base.ref);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const scratch = new Map<string, GitObject>();
    const lookup = (oid: string): GitObject | undefined => scratch.get(oid) ?? this.objects.get(oid);
    const put = (type: GitObjectType, data: Buffer): string => {
      const oid = hashObject(type, data);
      if (!scratch.has(oid)) scratch.set(oid, { type, data });
      return oid;
    };
    const base = mergeBase(baseTip, headTip, lookup);
    const result = mergeTrees(
      base === null ? EMPTY_TREE : this.commitView(base).tree,
      this.commitView(baseTip).tree,
      this.commitView(headTip).tree,
      lookup,
      put,
    );
    return result.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Merge a pull request onto its base branch. Squash by default; 405 on a conflict. */
  mergePull(
    repo: Repo,
    number: number,
    method: string,
    commitTitle?: string,
    commitMessage?: string,
  ): { sha: string; merged: true; message: string } {
    const pull = this.getPull(repo, number);
    if (pull.merged) throw new ApiError(405, 'Pull Request is already merged');
    if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
    const headTip = this.branchSha(repo, pull.head.ref);
    const baseTip = this.branchSha(repo, pull.base.ref);
    if (headTip === undefined || baseTip === undefined) throw new ApiError(405, 'Pull Request is not mergeable: a branch was deleted');
    if (headTip === baseTip || isAncestor(headTip, baseTip, this.lookup)) {
      throw new ApiError(405, 'Pull Request is not mergeable: nothing to commit');
    }
    const base = mergeBase(baseTip, headTip, this.lookup);
    const result = mergeTrees(
      base === null ? EMPTY_TREE : this.commitView(base).tree,
      this.commitView(baseTip).tree,
      this.commitView(headTip).tree,
      this.lookup,
      (t, d) => this.put(t, d),
    );
    if (result.conflict || result.tree === null) throw new ApiError(405, 'Merge conflict');
    const title = commitTitle ?? `${pull.title} (#${pull.number})`;
    let message: string;
    let parents: string[];
    if (method === 'merge') {
      message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${title}\n`;
      parents = [baseTip, headTip];
    } else {
      // squash and rebase both land one commit on the base branch.
      message = commitMessage !== undefined && commitMessage !== '' ? `${title}\n\n${commitMessage}\n` : `${title}\n`;
      parents = [baseTip];
    }
    const sha = this.put(
      'commit',
      buildCommit({ tree: result.tree, parents, message, author: COMMITTER, timestamp: this.commitTimestamp() }),
    );
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.tick();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }

  // ---------------------------------------------------------------- git smart HTTP support

  /** Index a received pack's objects into the global store. */
  storeObject(type: GitObjectType, data: Buffer): string {
    return this.put(type, data);
  }

  /** Whether a new tip's whole closure is present (a push must be connected). Objects are
   * immutable and the store only grows, so an oid proven connected once stays connected: the
   * cache makes a 200-push chain's connectivity check O(new objects) instead of O(history). */
  connected(tip: string): boolean {
    if (this.connectedSet.has(tip)) return true;
    const stack = [tip];
    const seen = new Set<string>();
    while (stack.length) {
      const oid = stack.pop()!;
      if (this.connectedSet.has(oid) || seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) return false;
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    for (const oid of seen) this.connectedSet.add(oid);
    return true;
  }

  /** Fast-forward check for a ref update: the current tip must be an ancestor of the new one. */
  fastForward(current: string, next: string): boolean {
    return isAncestor(current, next, this.lookup);
  }
}
