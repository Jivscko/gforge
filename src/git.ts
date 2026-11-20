// The git object model, in process: SHA-1 object ids, tree/commit/tag parsing and building,
// reachability walks, ancestry, tree diffs and three-way tree merges. Everything the forge serves
// over smart HTTP and the contents API is built from these primitives; there is no git binary.
// Node built-ins only (node:crypto for SHA-1).

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the content bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface CommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer?: string;
  readonly timestamp: number;
  readonly timezone?: string;
}

/** Build a commit object's bytes. The message is stored verbatim (callers end it with \n). */
export function buildCommit(fields: CommitFields): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author} ${fields.timestamp} ${timezone}`;
  const committer = `${fields.committer ?? fields.author} ${fields.timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------- reachability and ancestry

/**
 * Every object reachable from `roots`. `stopAt` commits are included but their parents are not
 * walked (a shallow boundary); `maxCommitDepth` caps how deep commit parents are walked (a want is
 * depth 1). Throws on a missing object unless allowMissing.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; stopAt?: ReadonlySet<string>; maxCommitDepth?: number } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) if (isObjectId(root)) queue.push({ oid: root, depth: 1 });
  while (queue.length) {
    const { oid, depth } = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, depth });
      const cut =
        (options.stopAt !== undefined && options.stopAt.has(oid)) ||
        (options.maxCommitDepth !== undefined && depth >= options.maxCommitDepth);
      if (!cut) for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit this repo does not hold
        queue.push({ oid: entry.oid, depth });
      }
    }
  }
  return seen;
}

/** The commit oids reachable from `roots`, walked to `maxDepth` (a want is depth 1). */
export function commitWalk(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  maxDepth: number,
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) if (isObjectId(root)) queue.push({ oid: root, depth: 1 });
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    const known = depths.get(oid);
    if (known !== undefined && known <= depth) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    depths.set(oid, depth);
    if (depth < maxDepth) {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return depths;
}

/** Peel a tag (chain) to the non-tag object it names. */
export function peel(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Whether `ancestor` is reachable from `tip` by commit parents (tip included). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (the first one a walk from `b` meets in `a`'s ancestry). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const oid = queue.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const seen = new Set<string>();
  const fromB = [b];
  while (fromB.length) {
    const oid = fromB.shift()!;
    if (ancestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) fromB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- tree diffs and merges

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
}

/** Flatten a tree to path → {mode, oid}, skipping gitlinks. */
export function flattenTree(treeOid: string, lookup: ObjectLookup, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const object = lookup(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(entry.oid, lookup, path)) out.set(childPath, child);
    } else if (entry.mode !== '160000') {
      out.set(path, entry);
    }
  }
  return out;
}

function lineCount(oid: string, lookup: ObjectLookup): number {
  const object = lookup(oid);
  if (!object || object.type !== 'blob' || object.data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < object.data.length; i += 1) if (object.data[i] === 0x0a) lines += 1;
  if (object.data[object.data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** The changed files between two trees (base → head), with line counts. */
export function diffTrees(baseTree: string, headTree: string, lookup: ObjectLookup): FileChange[] {
  const base = flattenTree(baseTree, lookup);
  const head = flattenTree(headTree, lookup);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) {
      changes.push({ path, status: 'added', additions: lineCount(entry.oid, lookup), deletions: 0 });
    } else if (old.oid !== entry.oid || old.mode !== entry.mode) {
      changes.push({
        path,
        status: 'modified',
        additions: lineCount(entry.oid, lookup),
        deletions: lineCount(old.oid, lookup),
      });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) changes.push({ path, status: 'removed', additions: 0, deletions: lineCount(entry.oid, lookup) });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

export interface MergeResult {
  /** The merged tree's oid, or null when the merge conflicts. */
  readonly tree: string | null;
  readonly conflict: boolean;
}

/**
 * Three-way merge of two trees against their common base, producing a new tree in the store.
 * A path both sides changed differently is a conflict; a path one side changed takes that side.
 * `put` stores a built object and returns its oid.
 */
export function mergeTrees(
  baseOid: string | null,
  oursOid: string,
  theirsOid: string,
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
): MergeResult {
  if (oursOid === theirsOid) return { tree: oursOid, conflict: false };
  if (baseOid === oursOid) return { tree: theirsOid, conflict: false };
  if (baseOid === theirsOid) return { tree: oursOid, conflict: false };
  const baseEntries = baseOid === null ? new Map<string, TreeEntry>() : new Map(parseTree(lookup(baseOid)?.data ?? Buffer.alloc(0)).map((e) => [e.name, e]));
  const ours = new Map(parseTree(lookup(oursOid)?.data ?? Buffer.alloc(0)).map((e) => [e.name, e]));
  const theirs = new Map(parseTree(lookup(theirsOid)?.data ?? Buffer.alloc(0)).map((e) => [e.name, e]));
  const names = new Set([...ours.keys(), ...theirs.keys()]);
  const merged: TreeEntry[] = [];
  let conflict = false;
  for (const name of names) {
    const b = baseEntries.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    // One side deleted, the other kept or changed.
    if (o === undefined || t === undefined) {
      const kept = o ?? t;
      if (kept === undefined) continue; // both deleted
      if (b === undefined) {
        // Added on one side only: take it.
        merged.push(kept);
        continue;
      }
      const changedByOther = kept.oid !== b.oid || kept.mode !== b.mode;
      if (changedByOther) {
        conflict = true; // delete/modify conflict
        merged.push(kept);
      }
      // else: the other side deleted an unchanged entry — drop it.
      continue;
    }
    if (o.oid === t.oid && o.mode === t.mode) {
      merged.push(o);
      continue;
    }
    const baseSameAsOurs = b !== undefined && b.oid === o.oid && b.mode === o.mode;
    const baseSameAsTheirs = b !== undefined && b.oid === t.oid && b.mode === t.mode;
    if (baseSameAsOurs) {
      merged.push(t);
      continue;
    }
    if (baseSameAsTheirs) {
      merged.push(o);
      continue;
    }
    if (o.mode === '40000' && t.mode === '40000') {
      const child = mergeTrees(b?.mode === '40000' ? b.oid : null, o.oid, t.oid, lookup, put);
      if (child.conflict) conflict = true;
      if (child.tree !== null) merged.push({ mode: '40000', name, oid: child.tree });
      continue;
    }
    conflict = true;
    merged.push(o); // keep ours in the conflicted tree; the merge is refused anyway
  }
  if (conflict) return { tree: null, conflict: true };
  return { tree: put('tree', buildTree(merged)), conflict: false };
}

/** The blob oid at `path` in a tree, or null (a directory or an absent path answers null). */
export function treePathBlob(treeOid: string, path: string, lookup: ObjectLookup): string | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' || entry.mode === '160000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The tree oid at a directory path (the root tree for an empty path), or null. */
export function treePathDir(treeOid: string, path: string, lookup: ObjectLookup): string | null {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  let current = treeOid;
  for (const segment of segments) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/** A copy of the tree at `treeOid` with `path` set to `blobOid` (mode 100644), built in the store. */
export function treeWithFile(
  treeOid: string | null,
  path: string,
  blobOid: string | null,
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  const build = (current: string | null, index: number): string => {
    const entries = current === null ? [] : parseTree(lookup(current)?.data ?? Buffer.alloc(0));
    const name = segments[index]!;
    const kept = entries.filter((e) => e.name !== name);
    if (index === segments.length - 1) {
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
    } else {
      const existing = entries.find((e) => e.name === name && e.mode === '40000');
      const child = build(existing?.oid ?? null, index + 1);
      kept.push({ mode: '40000', name, oid: child });
    }
    return put('tree', buildTree(kept));
  };
  return build(treeOid, 0);
}
