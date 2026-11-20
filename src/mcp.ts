// MCP at /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, revision 2026-07-28 (server/discover,
// no handshake, no session) with the legacy initialize handshake answered too. Every reply is one
// application/json body inside the 3-second budget. The six tools act on the same store as REST, so
// an object created here reads back over /api/v3 with the same id.
//
// Wire rules the suite holds us to:
//   - no Authorization header is exactly HTTP 401;
//   - a body that is not JSON is HTTP 400 with JSON-RPC -32700;
//   - server/discover answers supportedVersions (YYYY-MM-DD revisions), serverInfo and capabilities.tools;
//   - tools/list offers the six canonical tools, byte-identical over repeated calls;
//   - an unknown tool is JSON-RPC -32602/-32601, never HTTP 500; missing required arguments are -32602;
//   - concurrent calls keep their own JSON-RPC ids (each POST is answered on its own socket).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { readBody, sendEmpty, sendJson } from './http.ts';

export interface McpContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

const SERVER_INFO = { name: 'gforge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: { listChanged: false } };

// ---------------------------------------------------------------- the tool table

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** The six tools, github-mcp-server's argument names. Static: two tools/list answers are byte-equal. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (store, args) =>
      repoJson(
        store.createRepo({
          name: str(args, 'name'),
          description: str(args, 'description'),
          private: args.private === true,
        }),
      ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => repoJson(store.getRepo(str(args, 'owner'), str(args, 'repo'))),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      return issueJson(repo, store.createIssue(repo, { title: str(args, 'title'), body: str(args, 'body') }));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      const state = str(args, 'state') || 'open';
      return store.listIssues(repo, { state }).map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      const pull = store.createPull(repo, {
        title: str(args, 'title'),
        body: str(args, 'body'),
        head: str(args, 'head'),
        base: str(args, 'base'),
      });
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash or rebase' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      const method = str(args, 'merge_method') || 'squash';
      return store.mergePull(repo, Number(args.pull_number), method);
    },
  },
];

const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

// ---------------------------------------------------------------- JSON-RPC plumbing

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Run one tool: validate required arguments, execute, wrap the result (or its error) MCP-style. */
function callTool(store: Store, params: Record<string, unknown>): Record<string, unknown> | RpcError {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { code: -32602, message: `Unknown tool: ${name}` };
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { code: -32602, message: `Missing required argument: ${required}` };
    }
  }
  try {
    const data = tool.run(store, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function isRpcError(value: Record<string, unknown> | RpcError): value is RpcError {
  return typeof (value as RpcError).code === 'number' && typeof (value as RpcError).message === 'string';
}

/** Handle one JSON-RPC request object; null for a notification (no answer body). */
function handleRpc(store: Store, message: Record<string, unknown>, protocolHeader: string | undefined): Record<string, unknown> | null {
  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  const hasId = message.id !== undefined;

  // The 2026-07-28 transport declares the revision on every request; refuse one we do not speak.
  if (protocolHeader !== undefined && protocolHeader !== '' && !SUPPORTED_VERSIONS.includes(protocolHeader)) {
    if (!hasId) return null;
    return rpcError(id, { code: -32022, message: `Unsupported protocol version: ${protocolHeader}`, data: { supported: SUPPORTED_VERSIONS } });
  }

  let result: unknown;
  switch (method) {
    case 'server/discover':
      result = {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'GitHub-compatible forge tools: repositories, issues and pull requests.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
      break;
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      result = {
        protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      };
      break;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: TOOLS_LIST };
      break;
    case 'tools/call': {
      const outcome = callTool(store, params);
      if (!hasId) return null;
      if (isRpcError(outcome)) return rpcError(id, outcome);
      return rpcResult(id as string | number, outcome);
    }
    default:
      if (!hasId) return null;
      return rpcError(id, { code: -32601, message: `Method not found: ${method}` });
  }
  if (!hasId) return null;
  return rpcResult(id as string | number, result);
}

// ---------------------------------------------------------------- the HTTP surface

export async function handleMcp(ctx: McpContext): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  if (method === 'DELETE') {
    // Session teardown: this server keeps no session, so any DELETE is a no-op success.
    sendEmpty(ctx.res, 200);
    return;
  }
  if (method !== 'POST') throw new ApiError(405, 'Method not allowed');
  if (!ctx.authed) throw new ApiError(401, 'Requires authentication');

  const raw = await readBody(ctx.req);
  if (raw === null) throw new ApiError(413, 'Body too large');
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, rpcError(null, { code: -32700, message: 'Parse error: the body is not JSON' }));
    return;
  }

  const protocolHeader = ctx.req.headers['mcp-protocol-version'];
  const revision = typeof protocolHeader === 'string' ? protocolHeader : undefined;

  if (Array.isArray(body)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of body) {
      if (!isRecord(entry)) {
        answers.push(rpcError(null, { code: -32600, message: 'Invalid request' }));
        continue;
      }
      const answer = handleRpc(ctx.store, entry, revision);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      sendEmpty(ctx.res, 202);
      return;
    }
    sendJson(ctx.res, 200, answers);
    return;
  }

  if (!isRecord(body)) {
    sendJson(ctx.res, 400, rpcError(null, { code: -32600, message: 'Invalid request: expected a JSON-RPC object' }));
    return;
  }
  const answer = handleRpc(ctx.store, body, revision);
  if (answer === null) {
    sendEmpty(ctx.res, 202);
    return;
  }
  sendJson(ctx.res, 200, answer);
}