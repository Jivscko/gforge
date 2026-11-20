// GraphQL v4 at /api/graphql — milestone 3 fills this in (parser, schema, executor, batching).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Store } from './store.ts';

export interface GraphQLContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly store: Store;
  readonly authed: boolean;
}

export async function handleGraphQL(_ctx: GraphQLContext): Promise<void> {
  throw new ApiError(404, 'Not Found');
}
