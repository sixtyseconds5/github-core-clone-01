// In-memory forge state: one global object store (content-addressed) plus per-repo
// refs, issues, pull requests and labels. Deterministic: timestamps come from a fixed
// base plus a sequence counter, never from the wall clock, so two runs on the same
// instance leave the same exported state byte for byte.

import {
  ZERO_OID,
  buildCommitBytes,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobjs.ts';
import { VIEWER } from './scenario.ts';

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
  readonly createdSeq: number;
  readonly createdAt: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
  readonly createdAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly fullName: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

const TIME_BASE = 1_700_000_000; // fixed base epoch: deterministic timestamps
const TIME_STEP = 1;

export class ForgeStore {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private seq = 0;
  private requestSeq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  isoAt(seq: number): string {
    return new Date((TIME_BASE + seq * TIME_STEP) * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  nextCommentId(): number {
    return this.newId();
  }

  private newId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  // ------------------------------------------------------------ objects

  putObject(type: GitObjectType, data: Uint8Array): string {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: body });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  private objectType(oid: string): GitObjectType | undefined {
    return this.objects.get(oid)?.type;
  }

  commitOf(oid: string) {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** Peel a ref target to its commit oid (tags resolved), or undefined. */
  peelToCommit(oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') current = parseTag(object.data).object;
      else return undefined;
    }
    return undefined;
  }

  // ------------------------------------------------------------ repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo {
    const id = this.newId();
    const repo: Repo = {
      id,
      name,
      owner,
      fullName: `${owner}/${name}`,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      labels: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  /** Resolve a branch name, full ref, or oid to a commit oid, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = this.objects.get(ref);
      if (!object) return undefined;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return this.peelToCommit(ref);
      return undefined;
    }
    if (ref.startsWith('refs/')) {
      const target = repo.refs.get(ref);
      if (!target) return undefined;
      return this.peelToCommit(target);
    }
    const head = repo.refs.get(this.refName(ref));
    if (head) return this.peelToCommit(head);
    return undefined;
  }

  defaultTip(repo: Repo): string | undefined {
    const target = repo.refs.get(this.refName(repo.defaultBranch));
    if (!target) return undefined;
    return this.peelToCommit(target);
  }

  // ------------------------------------------------------------ trees

  /** Read a file or directory entry at a commit's tree. */
  lookupPath(commitOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | undefined {
    const commit = this.commitOf(commitOid);
    if (!commit) return undefined;
    const segments = path.split('/').filter(Boolean);
    let treeOid = commit.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const treeObject = this.objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') return undefined;
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) {
        return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    return { kind: 'dir', oid: treeOid, mode: '40000' };
  }

  readBlob(commitOid: string, path: string): Buffer | undefined {
    const found = this.lookupPath(commitOid, path);
    if (!found || found.kind !== 'file') return undefined;
    const object = this.objects.get(found.oid);
    if (!object || object.type !== 'blob') return undefined;
    return object.data;
  }

  listDir(commitOid: string, path: string): TreeEntry[] | undefined {
    const found = this.lookupPath(commitOid, path);
    if (!found || found.kind !== 'dir') return undefined;
    const object = this.objects.get(found.oid);
    if (!object || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }

  /** Build a new tree by writing `content` at `path` over `baseTreeOid` ('' = empty). */
  private writePath(baseTreeOid: string, segments: string[], content: Buffer): string {
    if (segments.length === 0) throw new Error('empty path');
    const entries: TreeEntry[] = baseTreeOid ? parseTree(this.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const name = segments[0] as string;
    const existing = entries.find((entry) => entry.name === name);
    let newOid: string;
    let newMode: string;
    if (segments.length === 1) {
      newOid = this.putObject('blob', content);
      newMode = '100644';
    } else {
      newOid = this.writePath(existing && existing.mode === '40000' ? existing.oid : '', segments.slice(1), content);
      newMode = '40000';
    }
    const filtered = entries.filter((entry) => entry.name !== name);
    filtered.push({ mode: newMode, name, oid: newOid });
    const treeData = buildTree(filtered);
    return this.putObject('tree', treeData);
  }

  /** Build a new tree by deleting `path` from `baseTreeOid`; undefined if absent. */
  private deletePath(baseTreeOid: string, segments: string[]): string | undefined {
    const entries = parseTree(this.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0));
    const name = segments[0] as string;
    const existing = entries.find((entry) => entry.name === name);
    if (!existing) return undefined;
    const kept = entries.filter((entry) => entry.name !== name);
    if (segments.length === 1) {
      return kept.length ? this.putObject('tree', buildTree(kept)) : this.putObject('tree', Buffer.alloc(0));
    }
    if (existing.mode !== '40000') return undefined;
    const child = this.deletePath(existing.oid, segments.slice(1));
    if (child === undefined) return undefined;
    const childEntries = parseTree(this.objects.get(child)?.data ?? Buffer.alloc(0));
    if (childEntries.length === 0) {
      return kept.length ? this.putObject('tree', buildTree(kept)) : this.putObject('tree', Buffer.alloc(0));
    }
    kept.push({ mode: '40000', name, oid: child });
    return this.putObject('tree', buildTree(kept));
  }

  /** Create a commit on `branch` that writes `content` at `path` (or deletes it). */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { sha: string; created: boolean } {
    const ref = this.refName(branch);
    const tip = this.defaultTip(repo);
    const branchTip = repo.refs.get(ref);
    const baseCommitOid = branchTip ? this.peelToCommit(branchTip) : tip;
    const baseTreeOid = baseCommitOid ? (this.commitOf(baseCommitOid)?.tree ?? '') : '';
    const segments = path.split('/').filter(Boolean);
    let newTreeOid: string;
    if (content === null) {
      const deleted = this.deletePath(baseTreeOid, segments);
      if (deleted === undefined) throw new Error('path does not exist');
      newTreeOid = deleted;
    } else {
      newTreeOid = this.writePath(baseTreeOid, segments, content);
    }
    const seq = this.nextSeq();
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommitBytes({
      tree: newTreeOid,
      parents: baseCommitOid ? [baseCommitOid] : [],
      message,
      author: identity,
      committer: identity,
      timestamp: 1_700_000_000 + seq,
    });
    const sha = this.putObject('commit', commitData);
    repo.refs.set(ref, sha);
    return { sha, created: !branchTip };
  }

  // ------------------------------------------------------------ commits

  /** All commits reachable from `tip`, newest first (by deterministic timestamp). */
  listCommits(tip: string): { sha: string; message: string; timestamp: number }[] {
    const reachable = collectReachable([tip], (oid) => this.objects.get(oid));
    const rows: { sha: string; message: string; timestamp: number }[] = [];
    for (const oid of reachable) {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const authorLine = commit.author;
      const timestamp = Number.parseInt(authorLine.split(' ').at(-2) ?? '0', 10) || 0;
      rows.push({ sha: oid, message: commit.message.replace(/\n$/, ''), timestamp });
    }
    rows.sort((a, b) => b.timestamp - a.timestamp || b.sha.localeCompare(a.sha));
    return rows;
  }

  /** First common ancestor of two commits (merge base), or undefined. */
  mergeBase(left: string, right: string): string | undefined {
    const leftAncestors = new Set<string>();
    const queue = [left];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (leftAncestors.has(oid)) continue;
      leftAncestors.add(oid);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    const walk = [right];
    const seen = new Set<string>();
    while (walk.length) {
      const oid = walk.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (leftAncestors.has(oid)) return oid;
      const commit = this.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) walk.push(parent);
    }
    return undefined;
  }

  /** Recursive tree diff: base tree vs head tree, keyed by path. */
  diffTrees(baseTreeOid: string, headTreeOid: string, prefix = ''): { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }[] {
    const baseEntries = baseTreeOid ? parseTree(this.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const headEntries = headTreeOid ? parseTree(this.objects.get(headTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const baseByName = new Map(baseEntries.map((entry) => [entry.name, entry]));
    const headByName = new Map(headEntries.map((entry) => [entry.name, entry]));
    const out: { path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }[] = [];
    const names = [...new Set([...baseByName.keys(), ...headByName.keys()])].sort();
    for (const name of names) {
      const base = baseByName.get(name);
      const head = headByName.get(name);
      const path = prefix ? `${prefix}/${name}` : name;
      const baseIsDir = base?.mode === '40000';
      const headIsDir = head?.mode === '40000';
      if (baseIsDir && headIsDir) {
        out.push(...this.diffTrees(base.oid, head.oid, path));
      } else if (baseIsDir && !head) {
        // A whole directory was removed: list its files, not the directory.
        out.push(...this.diffTrees(base.oid, '', path));
      } else if (!base && headIsDir) {
        // A whole directory was added: list its files, not the directory.
        out.push(...this.diffTrees('', head.oid, path));
      } else if (base && head && baseIsDir !== headIsDir) {
        // File replaced by a directory (or the reverse): remove one, add the other.
        if (baseIsDir) out.push(...this.diffTrees(base.oid, '', path));
        else out.push({ path, status: 'removed', baseOid: base.oid, headOid: null });
        if (headIsDir) out.push(...this.diffTrees('', head.oid, path));
        else out.push({ path, status: 'added', baseOid: null, headOid: head.oid });
      } else if (base && !head) {
        out.push({ path, status: 'removed', baseOid: base.oid, headOid: null });
      } else if (!base && head) {
        out.push({ path, status: 'added', baseOid: null, headOid: head.oid });
      } else if (base && head && base.oid !== head.oid) {
        out.push({ path, status: 'modified', baseOid: base.oid, headOid: head.oid });
      }
    }
    return out;
  }

  /** Three-way merge of `headTree` onto `baseTree` with `ancestorTree` as merge base.
   *  Returns the merged tree oid, or undefined on conflict. */
  mergeTrees(ancestorTreeOid: string, baseTreeOid: string, headTreeOid: string, prefix = ''): string | undefined {
    const ancestorEntries = ancestorTreeOid ? parseTree(this.objects.get(ancestorTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const baseEntries = baseTreeOid ? parseTree(this.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const headEntries = headTreeOid ? parseTree(this.objects.get(headTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const ancestorByName = new Map(ancestorEntries.map((entry) => [entry.name, entry]));
    const baseByName = new Map(baseEntries.map((entry) => [entry.name, entry]));
    const headByName = new Map(headEntries.map((entry) => [entry.name, entry]));
    const names = [...new Set([...ancestorByName.keys(), ...baseByName.keys(), ...headByName.keys()])].sort();
    const merged: TreeEntry[] = [];
    for (const name of names) {
      const ancestor = ancestorByName.get(name);
      const base = baseByName.get(name);
      const head = headByName.get(name);
      if (ancestor?.mode === '40000' || base?.mode === '40000' || head?.mode === '40000') {
        const sub = this.mergeTrees(ancestor?.oid ?? '', base?.oid ?? '', head?.oid ?? '', prefix ? `${prefix}/${name}` : name);
        if (sub === undefined) return undefined;
        const subEntries = parseTree(this.objects.get(sub)?.data ?? Buffer.alloc(0));
        if (subEntries.length) merged.push({ mode: '40000', name, oid: sub });
        continue;
      }
      const baseChanged = (base?.oid ?? null) !== (ancestor?.oid ?? null);
      const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
      if (baseChanged && headChanged && (base?.oid ?? null) !== (head?.oid ?? null)) return undefined;
      if (headChanged) {
        if (head) merged.push({ mode: head.mode, name, oid: head.oid });
      } else if (base) {
        merged.push({ mode: base.mode, name, oid: base.oid });
      }
    }
    return this.putObject('tree', buildTree(merged));
  }

  /** Is `tip` a descendant of `ancestor` (fast-forward legal)? */
  isFastForward(ancestor: string, tip: string): boolean {
    if (ancestor === ZERO_OID) return true;
    return isAncestor(ancestor, tip, (oid) => this.objects.get(oid));
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.newId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: seq,
      createdAt: this.isoAt(seq),
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const seq = this.nextSeq();
    const pull: Pull = {
      id: this.newId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      createdAt: this.isoAt(seq),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  pullFiles(pull: Pull): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const headCommit = this.commitOf(pull.headSha);
    const baseCommit = this.commitOf(pull.baseSha);
    const ancestor = this.mergeBase(pull.headSha, pull.baseSha);
    const ancestorCommit = ancestor ? this.commitOf(ancestor) : undefined;
    const baseTree = ancestorCommit ? ancestorCommit.tree : baseCommit?.tree ?? '';
    const headTree = headCommit?.tree ?? '';
    const diff = this.diffTrees(baseTree, headTree);
    return diff.map((change) => {
      const baseLines = change.baseOid ? this.blobLines(change.baseOid) : [];
      const headLines = change.headOid ? this.blobLines(change.headOid) : [];
      const baseSet = new Set(baseLines);
      const headSet = new Set(headLines);
      const additions = headLines.filter((line) => !baseSet.has(line)).length;
      const deletions = baseLines.filter((line) => !headSet.has(line)).length;
      return {
        filename: change.path,
        status: change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  private blobLines(oid: string): string[] {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return [];
    return object.data.toString('utf8').split('\n').filter((line) => line.length > 0);
  }

  /** The base branch's current tip (a pull's stored baseSha goes stale when the base moves). */
  private currentBaseSha(repo: Repo, pull: Pull): string | undefined {
    const tip = repo.refs.get(this.refName(pull.baseRef));
    return tip ? this.peelToCommit(tip) : undefined;
  }

  /** Is this pull mergeable (no conflicting changes vs the merge base)? */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const baseSha = this.currentBaseSha(repo, pull) ?? pull.baseSha;
    const ancestor = this.mergeBase(pull.headSha, baseSha);
    if (!ancestor) return false;
    const ancestorTree = this.commitOf(ancestor)?.tree ?? '';
    const baseTree = this.commitOf(baseSha)?.tree ?? '';
    const headTree = this.commitOf(pull.headSha)?.tree ?? '';
    return this.mergeTrees(ancestorTree, baseTree, headTree) === undefined;
  }

  /** Squash-merge a pull onto its base branch. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.merged) return null;
    const baseSha = this.currentBaseSha(repo, pull) ?? pull.baseSha;
    const ancestor = this.mergeBase(pull.headSha, baseSha);
    const ancestorTree = ancestor ? (this.commitOf(ancestor)?.tree ?? '') : '';
    const baseTree = this.commitOf(baseSha)?.tree ?? '';
    const headTree = this.commitOf(pull.headSha)?.tree ?? '';
    const mergedTree = this.mergeTrees(ancestorTree, baseTree, headTree);
    if (mergedTree === undefined) return null;
    const seq = this.nextSeq();
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitData = buildCommitBytes({
      tree: mergedTree,
      parents: [baseSha],
      message,
      author: identity,
      committer: identity,
      timestamp: 1_700_000_000 + seq,
    });
    const sha = this.putObject('commit', commitData);
    repo.refs.set(this.refName(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoAt(seq);
    pull.mergeCommitSha = sha;
    return sha;
  }
}
