// GraphQL v4 at /api/graphql: the documents gh and github-mcp-server send, served from the same
// store as REST. A small hand-rolled engine (no dependency): a tokenizer and parser for the GraphQL
// query language subset the wire uses (operations, variable definitions, aliases, arguments with
// variables / enums / lists / input objects, inline fragments), an executor over a resolver table,
// __type introspection from a static schema description, and operation batching (a JSON array of
// documents answers a JSON array of envelopes, in order).
//
// Wire rules the suite holds us to:
//   - an unauthenticated POST is exactly 401;
//   - an unknown field is HTTP 200 with an errors array naming the field, never an HTTP error;
//   - an unknown repository is data.repository = null with no errors;
//   - global ids are opaque (base64 of a typed key), stable across reads, never the plain number;
//   - issues(first, after, states, orderBy) filters, orders (CREATED_AT DESC, ties by number DESC)
//     and pages by cursor with pageInfo{hasNextPage, endCursor}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './identity.ts';
import { readBody, sendJson } from './http.ts';

export interface GraphQLContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

// ---------------------------------------------------------------- global ids

/** Opaque Relay-style global ids: base64 of a typed key, deterministic and stable. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`gforge:Repository:${repo.id}`, 'utf8').toString('base64');
}
export function issueGlobalId(issue: Issue): string {
  return Buffer.from(`gforge:Issue:${issue.id}`, 'utf8').toString('base64');
}
export function pullGlobalId(pull: Pull): string {
  return Buffer.from(`gforge:PullRequest:${pull.id}`, 'utf8').toString('base64');
}
function commentGlobalId(id: number): string {
  return Buffer.from(`gforge:IssueComment:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: unknown): { kind: string; id: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^gforge:([A-Za-z]+):(\d+)$/.exec(text);
  if (!match) return null;
  return { kind: match[1]!, id: Number(match[2]) };
}

function repoByGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === decoded.id) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === decoded.id) return { repo, issue };
  }
  return null;
}

function pullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === decoded.id) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------- the parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
}

class ParseError extends Error {}

const NAME_CHAR = /[_0-9A-Za-z]/;
const NAME_START = /[_A-Za-z]/;

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skip(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    this.skip();
    return this.text[this.pos] ?? '';
  }

  private take(expected: string): boolean {
    this.skip();
    if (this.text.startsWith(expected, this.pos)) {
      this.pos += expected.length;
      return true;
    }
    return false;
  }

  private expect(expected: string): void {
    if (!this.take(expected)) throw new ParseError(`expected '${expected}' at offset ${this.pos}`);
  }

  private name(): string {
    this.skip();
    const start = this.pos;
    if (this.pos < this.text.length && NAME_START.test(this.text[this.pos]!)) {
      this.pos += 1;
      while (this.pos < this.text.length && NAME_CHAR.test(this.text[this.pos]!)) this.pos += 1;
    }
    if (this.pos === start) throw new ParseError(`expected a name at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  document(): DocumentNode {
    const operations: OperationNode[] = [];
    for (;;) {
      const next = this.peek();
      if (next === '') break;
      if (next === '{') {
        operations.push({ operation: 'query', name: null, selections: this.selectionSet() });
        continue;
      }
      const word = this.name();
      if (word === 'query' || word === 'mutation') {
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.name();
        if (this.take('(')) {
          // Variable definitions: $name: Type [= default] — parsed, coercion is by value.
          while (!this.take(')')) {
            this.expect('$');
            this.name();
            this.expect(':');
            this.typeRef();
            if (this.take('=')) this.value();
          }
        }
        operations.push({ operation: word, name, selections: this.selectionSet() });
        continue;
      }
      if (word === 'fragment') {
        // Named fragments are not on the wire the suite sends; refuse them clearly.
        throw new ParseError('named fragments are not supported');
      }
      throw new ParseError(`unexpected token '${word}'`);
    }
    if (operations.length === 0) throw new ParseError('the document holds no operation');
    return { operations };
  }

  private typeRef(): void {
    if (this.take('[')) {
      this.typeRef();
      this.expect(']');
    } else {
      this.name();
    }
    this.take('!');
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const next = this.peek();
      if (next === '') throw new ParseError('unterminated selection set');
      if (this.take('}')) break;
      if (this.take('...')) {
        this.skip();
        if (this.text.startsWith('on', this.pos) && !NAME_CHAR.test(this.text[this.pos + 2] ?? '')) {
          this.pos += 2;
          const typeCondition = this.name();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.selectionSet() });
        } else {
          throw new ParseError('fragment spreads are not supported');
        }
        continue;
      }
      let name = this.name();
      let alias: string | null = null;
      if (this.take(':')) {
        alias = name;
        name = this.name();
      }
      const args: Record<string, ValueNode> = {};
      if (this.take('(')) {
        while (!this.take(')')) {
          const argName = this.name();
          this.expect(':');
          args[argName] = this.value();
        }
      }
      const sub = this.peek() === '{' ? this.selectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    return selections;
  }

  private value(): ValueNode {
    const next = this.peek();
    if (next === '') throw new ParseError('expected a value');
    if (this.take('$')) return { kind: 'variable', name: this.name() };
    if (this.take('[')) {
      const items: ValueNode[] = [];
      while (!this.take(']')) items.push(this.value());
      return { kind: 'list', items };
    }
    if (this.take('{')) {
      const fields: Record<string, ValueNode> = {};
      while (!this.take('}')) {
        const key = this.name();
        this.expect(':');
        fields[key] = this.value();
      }
      return { kind: 'object', fields };
    }
    if (next === '"') return { kind: 'string', value: this.string() };
    if (/[-0-9]/.test(next)) {
      const start = this.pos;
      this.take('-');
      while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.text[this.pos]!)) this.pos += 1;
      const raw = this.text.slice(start, this.pos);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ParseError(`invalid number '${raw}'`);
      return { kind: 'number', value };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private string(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseError('unterminated string');
      const ch = this.text[this.pos]!;
      this.pos += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.pos];
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc ?? '';
        continue;
      }
      out += ch;
    }
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = evalValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- tagged values and projection

/** An entity value carries its GraphQL type so inline fragments and resolvers can match it. */
interface Tagged {
  __type: string;
  [key: string]: unknown;
}

function tagged(type: string, fields: Record<string, unknown>): Tagged {
  return { __type: type, ...fields };
}

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

/** Project a resolved value through its selection set (scalars pass through, lists map). */
function project(value: unknown, selections: SelectionNode[], state: ExecState): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, selections, state));
  if (selections.length === 0) return value;
  if (typeof value === 'object' && typeof (value as Tagged).__type === 'string') {
    return execSelections((value as Tagged).__type, value as Tagged, selections, state);
  }
  // A plain record (pageInfo, payloads, connections): pick the requested keys.
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const key = selection.alias ?? selection.name;
    out[key] = project(record[selection.name], selection.selections, state);
  }
  return out;
}

function execSelections(typeName: string, value: Tagged, selections: SelectionNode[], state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const table = RESOLVERS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName) {
        Object.assign(out, execSelections(typeName, value, selection.selections, state));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolver = table?.[selection.name];
    if (resolver === undefined) {
      state.errors.push({ message: `Cannot query field '${selection.name}' on type '${typeName}'.` });
      out[key] = null;
      continue;
    }
    try {
      const args = evalArgs(selection.args, state.variables);
      const resolved = resolver(value, args, state.store);
      out[key] = project(resolved, selection.selections, state);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------- entity wrappers

function issueValue(issue: Issue): Tagged {
  return tagged('Issue', { issue });
}
function pullValue(repo: Repo, pull: Pull): Tagged {
  return tagged('PullRequest', { repo, pull });
}
function repoValue(repo: Repo): Tagged {
  return tagged('Repository', { repo });
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Order issues the way GitHub's issue connection does: the orderBy field, ties by number. */
function orderedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  if (states !== null && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issueState(issue)));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  const key = (issue: Issue): number => {
    if (field === 'UPDATED_AT') return issue.updatedSeq;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.createdSeq;
  };
  issues.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return diff * direction;
    return (a.number - b.number) * direction;
  });
  return issues;
}

function cursorOf(index: number): string {
  return Buffer.from(`gforge:cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^gforge:cursor:(\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** One page of a connection: nodes plus pageInfo, cursor by position in the ordered list. */
function connection(items: readonly unknown[], args: Record<string, unknown>, wrap: (item: never) => unknown): Record<string, unknown> {
  const firstRaw = Number(args.first ?? 30);
  const first = Number.isFinite(firstRaw) ? Math.max(0, Math.min(100, Math.trunc(firstRaw))) : 30;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    nodes: slice.map((item) => wrap(item as never)),
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(endIndex) : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------- the resolver table

type Resolver = (value: Tagged, args: Record<string, unknown>, store: Store) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => tagged('User', { login: VIEWER.login }),
    repository: (_v, args, store) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = store.findRepo(owner, name);
      return repo === undefined ? null : repoValue(repo);
    },
    node: (_v, args, store) => {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        for (const repo of store.repos.values()) if (repo.id === decoded.id) return repoValue(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = issueByGlobalId(store, args.id);
        if (found !== null) return issueValue(found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullByGlobalId(store, args.id);
        if (found !== null) return pullValue(found.repo, found.pull);
      }
      return null;
    },
    __type: (_v, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!(name in SCHEMA_FIELDS) && !(name in SCHEMA_ENUMS)) return null;
      return tagged('__Type', { name });
    },
  },
  Mutation: {
    createIssue: (_v, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(store, input.repositoryId);
      if (repo === null) throw new Error('Repository not found');
      const issue = store.createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { issue: issueValue(issue) };
    },
    closeIssue: (_v, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(store, input.issueId);
      if (found === null) throw new Error('Issue not found');
      const issue = store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
      return { issue: issueValue(issue) };
    },
    createPullRequest: (_v, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(store, input.repositoryId);
      if (repo === null) throw new Error('Repository not found');
      const pull = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { pullRequest: pullValue(repo, pull) };
    },
    mergePullRequest: (_v, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(store, input.pullRequestId);
      if (found === null) throw new Error('Pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      store.mergePull(found.repo, found.pull.number, method);
      return { pullRequest: pullValue(found.repo, found.pull) };
    },
    addComment: (_v, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(store, input.subjectId);
      if (found === null) throw new Error('Issue not found');
      const comment = store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
      return {
        commentEdge: { node: tagged('IssueComment', { id: commentGlobalId(comment.id), body: comment.body }) },
        subject: issueValue(found.issue),
      };
    },
  },
  User: {
    login: (v) => v.login,
    id: () => Buffer.from('gforge:User:1', 'utf8').toString('base64'),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (v) => repoGlobalId(v.repo as Repo),
    databaseId: (v) => (v.repo as Repo).id,
    name: (v) => (v.repo as Repo).name,
    nameWithOwner: (v) => `${(v.repo as Repo).owner}/${(v.repo as Repo).name}`,
    owner: (v) => tagged('User', { login: (v.repo as Repo).owner }),
    description: (v) => (v.repo as Repo).description,
    isPrivate: (v) => (v.repo as Repo).private,
    createdAt: (v) => (v.repo as Repo).createdAt,
    updatedAt: (v) => (v.repo as Repo).updatedAt,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (v, _args, store) => {
      const repo = v.repo as Repo;
      return store.branchSha(repo, repo.defaultBranch) === undefined ? null : tagged('Ref', { name: repo.defaultBranch });
    },
    issue: (v, args, store) => {
      const repo = v.repo as Repo;
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueValue(issue);
    },
    issues: (v, args, store) => {
      const repo = v.repo as Repo;
      return connection(orderedIssues(repo, args), args, (issue: Issue) => issueValue(issue));
    },
    pullRequest: (v, args) => {
      const repo = v.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullValue(repo, pull);
    },
    pullRequests: (v, args) => {
      const repo = v.repo as Repo;
      let pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null && states.length > 0) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      return connection(pulls, args, (pull: Pull) => pullValue(repo, pull));
    },
  },
  Ref: {
    name: (v) => v.name,
  },
  Issue: {
    id: (v) => issueGlobalId(v.issue as Issue),
    number: (v) => (v.issue as Issue).number,
    title: (v) => (v.issue as Issue).title,
    body: (v) => (v.issue as Issue).body,
    state: (v) => issueState(v.issue as Issue),
    createdAt: (v) => (v.issue as Issue).createdAt,
    updatedAt: (v) => (v.issue as Issue).updatedAt,
    closedAt: (v) => (v.issue as Issue).closedAt,
    author: () => tagged('User', { login: VIEWER.login }),
    url: (v) => `/issues/${(v.issue as Issue).number}`,
  },
  IssueComment: {
    id: (v) => v.id,
    body: (v) => v.body,
  },
  PullRequest: {
    id: (v) => pullGlobalId(v.pull as Pull),
    number: (v) => (v.pull as Pull).number,
    title: (v) => (v.pull as Pull).title,
    body: (v) => (v.pull as Pull).body,
    state: (v) => pullState(v.pull as Pull),
    merged: (v) => (v.pull as Pull).merged,
    mergedAt: (v) => (v.pull as Pull).mergedAt,
    closedAt: (v) => (v.pull as Pull).mergedAt,
    createdAt: (v) => (v.pull as Pull).createdAt,
    updatedAt: (v) => (v.pull as Pull).updatedAt,
    headRefName: (v) => (v.pull as Pull).head.ref,
    baseRefName: (v) => (v.pull as Pull).base.ref,
    headRefOid: (v) => (v.pull as Pull).head.sha,
    baseRefOid: (v) => (v.pull as Pull).base.sha,
    mergeCommit: (v) => {
      const pull = v.pull as Pull;
      return pull.mergeCommitSha === null ? null : tagged('Commit', { oid: pull.mergeCommitSha });
    },
    mergeable: (v, _args, store) => store.mergeableState(v.repo as Repo, v.pull as Pull),
    author: () => tagged('User', { login: VIEWER.login }),
    files: (v, args, store) => {
      const changes = store.pullFiles(v.repo as Repo, v.pull as Pull);
      return connection(changes, args, (change: { path: string }) => tagged('PullRequestChangedFile', { path: change.path }));
    },
  },
  PullRequestChangedFile: {
    path: (v) => v.path,
  },
  Commit: {
    oid: (v) => v.oid,
  },
  __Type: {
    name: (v) => v.name,
    kind: (v) => ((v.name as string) in SCHEMA_ENUMS ? 'ENUM' : 'OBJECT'),
    fields: (v) => {
      const fields = SCHEMA_FIELDS[v.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => ({ name, description: null, isDeprecated: false, args: [] }));
    },
    enumValues: (v) => {
      const values = SCHEMA_ENUMS[v.name as string];
      if (values === undefined) return null;
      return values.map((name) => ({ name, description: null, isDeprecated: false }));
    },
  },
};

// ---------------------------------------------------------------- the static schema description

/** The field names introspection lists per type (a superset of what the resolvers serve). */
const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'createdAt', 'updatedAt',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'labels', 'comments'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'closedAt', 'createdAt', 'updatedAt',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'mergeCommit', 'files', 'author', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Commit: ['oid', 'message'],
};

const SCHEMA_ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- execution and the HTTP surface

interface Envelope {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeOperation(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): Envelope {
  let document: DocumentNode;
  try {
    document = new Parser(query).document();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    operationName !== undefined && operationName !== ''
      ? document.operations.find((op) => op.name === operationName)
      : document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named '${operationName ?? ''}'.` }] };
  }
  const state: ExecState = { store, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(rootType, tagged(rootType, {}), operation.selections, state);
  if (state.errors.length > 0) return { data: null, errors: state.errors };
  return { data };
}

function envelopeOf(store: Store, entry: unknown): Envelope {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'The operation must be a JSON object with a query.' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'The operation carries no query document.' }] };
  }
  const variables =
    typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  try {
    return executeOperation(store, query, variables, operationName);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** POST /api/graphql: one {query, variables} document, or a JSON array of them (batching). */
export async function handleGraphQL(ctx: GraphQLContext): Promise<void> {
  if (!ctx.authed) throw new ApiError(401, 'Requires authentication');
  if ((ctx.req.method ?? 'GET') !== 'POST') throw new ApiError(404, 'Not Found');
  const raw = await readBody(ctx.req);
  if (raw === null) throw new ApiError(413, 'Body too large');
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (Array.isArray(body)) {
    sendJson(ctx.res, 200, body.map((entry) => envelopeOf(ctx.store, entry)));
    return;
  }
  sendJson(ctx.res, 200, envelopeOf(ctx.store, body));
}