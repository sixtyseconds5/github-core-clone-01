// Git smart HTTP: info/refs advertisement (v2 and v0), upload-pack fetch
// (v2 and v0, shallow/deepen aware) and receive-pack push (report-status).
// Packs sent are plain objects only; packs received may carry deltas.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
  type Pkt,
} from './gitobjs.ts';
import type { ForgeStore, Repo } from './store.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function jsonResult(status: number, message: string): GitHttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function refLines(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const names = [...repo.refs.keys()].sort();
  const out: { oid: string; name: string; peeled?: string }[] = [];
  const defaultTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({ oid: defaultTarget ?? ZERO_OID, name: 'HEAD' });
  for (const name of names) {
    out.push({ oid: repo.refs.get(name) as string, name });
  }
  return out;
}

/** Peeled commit for an annotated tag ref, or undefined. */
function peeledCommit(store: ForgeStore, oid: string): string | undefined {
  const object = store.getObject(oid);
  if (!object || object.type !== 'tag') return undefined;
  return store.peelToCommit(oid);
}

// ------------------------------------------------------------- advertisement

function advertiseUploadPackV0(store: ForgeStore, repo: Repo): Buffer {
  const caps = 'side-band-64k multi_ack thin-pack ofs-delta shallow agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktFlush()];
  const refs = refLines(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const head = refs[0] as { oid: string; name: string };
    parts.push(encodePktLine(`${head.oid} HEAD\u0000${caps}\n`));
    for (const ref of realRefs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledCommit(store, ref.oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseUploadPackV2(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow thin-pack\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
}

function advertiseReceivePackV0(store: ForgeStore, repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = refLines(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const head = refs[0] as { oid: string; name: string };
    parts.push(encodePktLine(`${head.oid} HEAD\u0000${caps}\n`));
    for (const ref of realRefs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledCommit(store, ref.oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(store: ForgeStore, repo: Repo, service: string | null, gitProtocol: string | null): GitHttpResult {
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseUploadPackV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseUploadPackV0(store, repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseReceivePackV0(store, repo) };
  }
  return jsonResult(400, 'unknown service');
}

// ------------------------------------------------------------- fetch computation

interface FetchPlan {
  readonly send: Set<string>;
  readonly newShallow: string[];
  readonly unshallow: string[];
}

function depthLimitedReachable(store: ForgeStore, wants: string[], depth: number | undefined): { objects: Set<string>; commits: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const object = store.getObject(want);
    if (!object) continue;
    if (object.type === 'tag') {
      objects.add(want);
      const target = store.peelToCommit(want);
      if (target) queue.push({ oid: target, gen: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 1 });
    } else {
      objects.add(want);
    }
  }
  const lookup = (oid: string): GitObject | undefined => store.getObject(oid);
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const seen = commitGen.get(oid);
    if (seen !== undefined && seen <= gen) continue;
    commitGen.set(oid, gen);
    commits.add(oid);
    const commit = parseCommit(store.getObject(oid)?.data ?? Buffer.alloc(0));
    objects.add(oid);
    collectTreeObjects(store, commit.tree, objects);
    if (depth === undefined || gen < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  const boundary = new Set<string>();
  for (const commitOid of commits) {
    const commit = parseCommit(store.getObject(commitOid)?.data ?? Buffer.alloc(0));
    if (commit.parents.every((parent) => !commits.has(parent))) boundary.add(commitOid);
  }
  void lookup;
  return { objects, commits, boundary };
}

function collectTreeObjects(store: ForgeStore, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = store.getObject(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
}

/** Objects the client already holds: reachable from haves, cut at shallow boundaries. */
function heldObjects(store: ForgeStore, haves: string[], shallowBoundaries: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (held.has(oid)) continue;
    const object = store.getObject(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      collectTreeObjects(store, commit.tree, held);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      collectTreeObjects(store, oid, held);
    }
  }
  return held;
}

function computeFetch(store: ForgeStore, wants: string[], haves: string[], shallowBoundaries: string[], deepen: number | undefined): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  const { objects: wanted, boundary } = depthLimitedReachable(store, wants, deepen);
  const held = heldObjects(store, haves, shallowSet);
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);
  const newShallow = deepen === undefined ? [] : [...boundary].filter((oid) => send.has(oid) || wanted.has(oid));
  const unshallow = shallowBoundaries.filter((oid) => wanted.has(oid) && !boundary.has(oid));
  return { send, newShallow, unshallow };
}

function orderForPack(store: ForgeStore, send: Set<string>): GitObject[] {
  const objects: GitObject[] = [];
  const byType: Record<string, GitObject[]> = { commit: [], tree: [], blob: [], tag: [] };
  for (const oid of send) {
    const object = store.getObject(oid);
    if (object) byType[object.type].push(object);
  }
  for (const type of ['commit', 'tag', 'tree', 'blob']) objects.push(...(byType[type] as GitObject[]));
  return objects;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(offset + chunkSize, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------- upload-pack

function lsRefsResponse(store: ForgeStore, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let prefix: string | undefined;
  for (const rawArg of args) {
    const arg = rawArg.trimEnd();
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefix = arg.slice('ref-prefix '.length);
  }
  void symrefs;
  const parts: Buffer[] = [];
  const defaultTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headUnborn = !defaultTarget;
  const lines: string[] = [];
  if (headUnborn && unborn) {
    lines.push('unborn HEAD symref-target:refs/heads/main\n');
  } else if (defaultTarget) {
    lines.push(`${defaultTarget} HEAD symref-target:refs/heads/main\n`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledCommit(store, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  for (const line of lines) {
    const name = line.split(' ')[1] ?? '';
    if (prefix && !name.startsWith(prefix)) continue;
    if (line.startsWith('unborn ')) {
      if (prefix && !'HEAD'.startsWith(prefix)) continue;
      parts.push(encodePktLine(line));
      continue;
    }
    parts.push(encodePktLine(line));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

const FETCH_CACHE_CAP = 128;

/** Cache key for a fetch response: protocol + store size + every fetch parameter. */
function fetchCacheKey(store: ForgeStore, version: 'v2' | 'v0', wants: string[], haves: string[], shallow: string[], deepen: number | undefined): string {
  return `${version}|${store.objects.size}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${deepen ?? ''}`;
}

/** A cached fetch response, or undefined. The cached Buffer is never mutated. */
function fetchCached(store: ForgeStore, key: string): Buffer | undefined {
  return store.fetchCache.get(key);
}

/** Store a fetch response unless the cache is full. */
function fetchStore(store: ForgeStore, key: string, body: Buffer): void {
  if (store.fetchCache.size < FETCH_CACHE_CAP) store.fetchCache.set(key, body);
}

function fetchResponseV2(store: ForgeStore, wants: string[], haves: string[], shallow: string[], deepen: number | undefined): Buffer {
  const key = fetchCacheKey(store, 'v2', wants, haves, shallow, deepen);
  const hit = fetchCached(store, key);
  if (hit) return hit;
  const body = fetchResponseV2Fresh(store, wants, haves, shallow, deepen);
  fetchStore(store, key, body);
  return body;
}

function fetchResponseV2Fresh(store: ForgeStore, wants: string[], haves: string[], shallow: string[], deepen: number | undefined): Buffer {
  const plan = computeFetch(store, wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of haves) {
      if (store.getObject(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(pktDelim());
  if (plan.newShallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.newShallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.send.size > 0) {
    const pack = writePack(orderForPack(store, plan.send));
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(store: ForgeStore, wants: string[], haves: string[], shallow: string[], deepen: number | undefined): Buffer {
  const key = fetchCacheKey(store, 'v0', wants, haves, shallow, deepen);
  const hit = fetchCached(store, key);
  if (hit) return hit;
  const body = fetchResponseV0Fresh(store, wants, haves, shallow, deepen);
  fetchStore(store, key, body);
  return body;
}

function fetchResponseV0Fresh(store: ForgeStore, wants: string[], haves: string[], shallow: string[], deepen: number | undefined): Buffer {
  const plan = computeFetch(store, wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  if (haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of haves) {
      if (store.getObject(have)) parts.push(encodePktLine(`ACK ${have}\n`));
    }
    parts.push(encodePktLine('ready\n'));
  }
  for (const oid of plan.newShallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.send.size > 0) {
    const pack = writePack(orderForPack(store, plan.send));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: string[]): { wants: string[]; haves: string[]; shallow: string[]; deepen: number | undefined } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('want ')) {
      const oid = line.split(' ')[1] ?? '';
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.split(' ')[1] ?? '';
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.split(' ')[1] ?? '';
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice('deepen '.length), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  return { wants, haves, shallow, deepen };
}

export function handleUploadPack(store: ForgeStore, repo: Repo, body: Buffer, gitProtocol: string | null): GitHttpResult {
  const { packets } = decodePktLines(body, true);
  const dataLines: string[] = [];
  const sections: string[][] = [[]];
  let current = sections[0] as string[];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      current = sections[sections.length - 1] as string[];
    } else if (packet.kind === 'data') {
      current.push(packet.payload.toString('utf8'));
    }
  }
  void dataLines;
  if (gitProtocol === 'version=2') {
    const first = (sections[0] as string[])[0] ?? '';
    const rest = (sections[0] as string[]).slice(1);
    if (first.startsWith('command=ls-refs')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, rest) };
    }
    if (first.startsWith('command=fetch')) {
      const parsed = parseFetchArgs(rest);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(store, parsed.wants, parsed.haves, parsed.shallow, parsed.deepen) };
    }
    return jsonResult(400, 'unknown upload-pack command');
  }
  // v0: wants in section 0, haves in section 1.
  const allLines = sections.flat();
  const parsed = parseFetchArgs(allLines);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(store, parsed.wants, parsed.haves, parsed.shallow, parsed.deepen) };
}

// ------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly old: string;
  readonly next: string;
  readonly ref: string;
}

export function handleReceivePack(store: ForgeStore, repo: Repo, body: Buffer): GitHttpResult {
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  let unpackError: string | undefined;
  try {
    const { packets, trailing } = decodePktLines(body, true);
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    packBytes = trailing;
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const nul = line.indexOf('\u0000');
      const head = nul < 0 ? line : line.slice(0, nul);
      const parts = head.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
        throw new Error('malformed receive-pack command line');
      }
      commands.push({ old: parts[0] as string, next: parts[1] as string, ref: parts[2] as string });
    }
  } catch (err) {
    return jsonResult(400, `malformed receive-pack request: ${(err as Error).message}`);
  }

  let objectCount = 0;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => store.getObject(oid));
      for (const [oid, object] of objects) {
        if (!store.getObject(oid)) store.objects.set(oid, object);
        objectCount += 1;
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyCommand(store, repo, command);
      reportLines.push(result === 'ok' ? `ok ${command.ref}\n` : `ng ${command.ref} ${result}\n`);
    }
  }
  const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < inner.length; offset += chunkSize) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(offset + chunkSize, inner.length))])));
  }
  if (objectCount > 0) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from(`Counting objects: 100% (${objectCount}/${objectCount}), done.\n`, 'utf8')])));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

function applyCommand(store: ForgeStore, repo: Repo, command: PushCommand): string {
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  const current = repo.refs.get(command.ref);
  if (command.next === ZERO_OID) {
    // Delete.
    if (!current) return 'cannot delete non-existent ref';
    if (command.old !== ZERO_OID && command.old !== current) return 'old value mismatch';
    repo.refs.delete(command.ref);
    return 'ok';
  }
  const target = store.getObject(command.next);
  if (!target) return 'object not found';
  const peeled = store.peelToCommit(command.next);
  if (!peeled) return 'not a commit';
  if (command.old === ZERO_OID) {
    if (current) return 'already exists';
    repo.refs.set(command.ref, command.next);
    return 'ok';
  }
  if (!current) return 'cannot update non-existent ref';
  if (current !== command.old) return 'stale info';
  if (!store.isFastForward(command.old, peeled)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.next);
  return 'ok';
}

export type { Pkt };
