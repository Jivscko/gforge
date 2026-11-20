// MCP at /mcp — milestone 4 fills this in (JSON-RPC 2.0, discover + handshake, the six tools).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Store } from './store.ts';

export interface McpContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

export async function handleMcp(_ctx: McpContext): Promise<void> {
  throw new ApiError(404, 'Not Found');
}
