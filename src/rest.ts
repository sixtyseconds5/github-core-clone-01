// REST API v3. Every reply is application/json, carries X-GitHub-Request-Id, and
// errors are {"message": string}; unknown routes are JSON 404s. A repository belongs
// to the login the bearer token names; the same name under another owner is a 404,
// never a 403. Malformed JSON bodies are 400s.

import { isObjectId, type GitObjectType } from './gitobjs.ts';
import { VIEWER } from './scenario.ts';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';

export interface Reply {
  status: number;
  contentType: string;
  body: Buffer | null;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8'), headers };
}

export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

export interface RestContext {
  readonly store: ForgeStore;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly baseUrl: string;
  readonly rawBody: Buffer;
}

function repoView(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    html_url: `${baseUrl}/repos/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdSeq ? new Date(1_700_000_000_000 + repo.createdSeq * 1000).toISOString() : undefined,
    updated_at: new Date(1_700_000_000_000 + repo.createdSeq * 1000).toISOString(),
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

interface Page {
  readonly items: unknown[];
  readonly link: string | undefined;
}

function paginate(items: unknown[], query: URLSearchParams, baseUrl: string, path: string): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${baseUrl}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { items: slice, link: links.length ? links.join(', ') : undefined };
}

function parseBody(rawBody: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (rawBody.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function findRepo(ctx: RestContext, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return ctx.store.getRepo(owner, name);
}

export function handleRest(ctx: RestContext): Reply {
  const { store, method, segments } = ctx;
  const path = `/${segments.join('/')}`;

  // Root and meta.
  if (method === 'GET' && segments.length === 0) {
    return jsonReply(200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // Current user.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    return jsonReply(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const page = paginate(repos.map((repo) => repoView(repo, ctx.baseUrl)), ctx.query, ctx.baseUrl, '/api/v3/user/repos');
      return jsonReply(200, page.items, page.link ? { Link: page.link } : undefined);
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx.rawBody);
      if (!parsed.ok) return errorReply(400, 'malformed JSON body');
      const name = asString(parsed.value.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return errorReply(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return errorReply(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER.login, name, {
        private: asBoolean(parsed.value.private) ?? false,
        description: asString(parsed.value.description) ?? '',
      });
      return jsonReply(201, repoView(repo, ctx.baseUrl));
    }
  }

  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = findRepo(ctx, owner, name);
    if (!repo) return errorReply(404, 'Not Found');
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return jsonReply(200, repoView(repo, ctx.baseUrl));
      if (method === 'PATCH') {
        const parsed = parseBody(ctx.rawBody);
        if (!parsed.ok) return errorReply(400, 'malformed JSON body');
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(parsed.value.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        return jsonReply(200, repoView(repo, ctx.baseUrl));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, contentType: 'application/json', body: null };
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: store.peelToCommit(repo.refs.get(`refs/heads/${branch}`) as string) } }));
        return jsonReply(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1] as string;
        const target = repo.refs.get(`refs/heads/${branch}`);
        if (!target) return errorReply(404, 'Branch not found');
        return jsonReply(200, { name: branch, commit: { sha: store.peelToCommit(target) } });
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const refParam = ctx.query.get('sha');
      const tip = refParam ? store.resolveRef(repo, refParam) : store.defaultTip(repo);
      if (!tip) return jsonReply(200, []);
      const commits = store.listCommits(tip).map((row) => {
        const object = store.getObject(row.sha);
        const commit = object ? parseCommitView(object.data) : { author: '', committer: '' };
        return {
          sha: row.sha,
          commit: {
            message: row.message,
            author: commit.author,
            committer: commit.committer,
          },
          parents: [],
        };
      });
      const page = paginate(commits, ctx.query, ctx.baseUrl, path);
      return jsonReply(200, page.items, page.link ? { Link: page.link } : undefined);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const branch = rest[3] as string;
        const target = repo.refs.get(`refs/heads/${branch}`);
        if (!target) return errorReply(404, 'Not Found');
        return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha: target, type: 'commit' } });
      }
      if (rest.length === 2 && method === 'POST') {
        const parsed = parseBody(ctx.rawBody);
        if (!parsed.ok) return errorReply(400, 'malformed JSON body');
        const ref = asString(parsed.value.ref);
        const sha = asString(parsed.value.sha);
        if (!ref || !ref.startsWith('refs/') || !sha || !isObjectId(sha)) return errorReply(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
        const peeled = store.peelToCommit(sha);
        if (!peeled) return errorReply(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonReply(201, { ref, object: { sha, type: 'commit' } });
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      const refParam = ctx.query.get('ref');
      const tip = refParam ? store.resolveRef(repo, refParam) : store.defaultTip(repo);
      if (method === 'GET') {
        if (!tip) return errorReply(404, 'Not Found');
        if (!contentPath) {
          const entries = store.listDir(tip, '') ?? [];
          return jsonReply(200, entries.map((entry) => ({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: entry.name, sha: entry.oid })));
        }
        const found = store.lookupPath(tip, contentPath);
        if (!found) return errorReply(404, 'Not Found');
        if (found.kind === 'dir') {
          const entries = store.listDir(tip, contentPath) ?? [];
          return jsonReply(200, entries.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${contentPath}/${entry.name}`,
            sha: entry.oid,
          })));
        }
        const blob = store.getObject(found.oid);
        if (!blob || blob.type !== 'blob') return errorReply(404, 'Not Found');
        const name = contentPath.split('/').at(-1) as string;
        return jsonReply(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name,
          path: contentPath,
          content: blob.data.toString('base64'),
          sha: found.oid,
        });
      }
      if (method === 'PUT' || method === 'DELETE') {
        const parsed = parseBody(ctx.rawBody);
        if (!parsed.ok) return errorReply(400, 'malformed JSON body');
        const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
        const message = asString(parsed.value.message) ?? (method === 'DELETE' ? 'Delete file' : 'Update file');
        const sha = asString(parsed.value.sha);
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const currentCommit = branchTip ? store.peelToCommit(branchTip) : store.defaultTip(repo);
        const current = currentCommit ? store.lookupPath(currentCommit, contentPath) : undefined;
        if (method === 'DELETE') {
          if (!current || current.kind !== 'file') return errorReply(404, 'Not Found');
          if (sha && sha !== current.oid) return errorReply(409, 'sha does not match the current blob');
          try {
            const result = store.commitFile(repo, branch, contentPath, null, message);
            return jsonReply(200, { commit: { sha: result.sha, message } });
          } catch {
            return errorReply(404, 'Not Found');
          }
        }
        const contentB64 = asString(parsed.value.content);
        if (contentB64 === undefined) return errorReply(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorReply(400, 'content is not valid base64');
        }
        if (current) {
          if (!sha) return errorReply(422, 'sha is required to update an existing file');
          if (sha !== current.oid) return errorReply(409, 'sha does not match the current blob');
          const result = store.commitFile(repo, branch, contentPath, content, message);
          const blobSha = store.lookupPath(result.sha, contentPath)?.oid ?? '';
          return jsonReply(200, { content: { name: contentPath.split('/').at(-1), path: contentPath, sha: blobSha, encoding: 'base64' }, commit: { sha: result.sha, message } });
        }
        if (sha) return errorReply(422, 'sha must not be provided when creating a file');
        const result = store.commitFile(repo, branch, contentPath, content, message);
        const blobSha = store.lookupPath(result.sha, contentPath)?.oid ?? '';
        return jsonReply(201, { content: { name: contentPath.split('/').at(-1), path: contentPath, sha: blobSha, encoding: 'base64' }, commit: { sha: result.sha, message } });
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return jsonReply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseBody(ctx.rawBody);
        if (!parsed.ok) return errorReply(400, 'malformed JSON body');
        const name = asString(parsed.value.name);
        const color = asString(parsed.value.color) ?? '000000';
        if (!name) return errorReply(422, 'name is required');
        if (repo.labels.has(name)) return errorReply(422, 'Label already exists');
        repo.labels.set(name, { name, color });
        return jsonReply(201, { name, color });
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const page = paginate(issues.map((issue) => issueView(repo, issue)), ctx.query, ctx.baseUrl, path);
          return jsonReply(200, page.items, page.link ? { Link: page.link } : undefined);
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx.rawBody);
          if (!parsed.ok) return errorReply(400, 'malformed JSON body');
          const title = asString(parsed.value.title);
          if (!title) return errorReply(422, 'title is required');
          const labels = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return errorReply(422, `label ${label} does not exist`);
          }
          const issue = store.createIssue(repo, title, asString(parsed.value.body) ?? '', labels);
          return jsonReply(201, issueView(repo, issue));
        }
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (rest.length === 2) {
        if (!issue) return errorReply(404, 'Not Found');
        if (method === 'GET') return jsonReply(200, issueView(repo, issue));
        if (method === 'PATCH') {
          const parsed = parseBody(ctx.rawBody);
          if (!parsed.ok) return errorReply(400, 'malformed JSON body');
          const state = asString(parsed.value.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(parsed.value.title);
          if (title !== undefined) issue.title = title;
          const body = asString(parsed.value.body);
          if (body !== undefined) issue.body = body;
          return jsonReply(200, issueView(repo, issue));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return errorReply(404, 'Not Found');
        if (method === 'GET') {
          const page = paginate(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login } })), ctx.query, ctx.baseUrl, path);
          return jsonReply(200, page.items, page.link ? { Link: page.link } : undefined);
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx.rawBody);
          if (!parsed.ok) return errorReply(400, 'malformed JSON body');
          const body = asString(parsed.value.body);
          if (!body) return errorReply(422, 'body is required');
          const comment = { id: store.nextCommentId(), body };
          issue.comments.push(comment);
          return jsonReply(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login } });
        }
      }
      return errorReply(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const page = paginate(pulls.map((pull) => pullView(repo, pull)), ctx.query, ctx.baseUrl, path);
          return jsonReply(200, page.items, page.link ? { Link: page.link } : undefined);
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx.rawBody);
          if (!parsed.ok) return errorReply(400, 'malformed JSON body');
          const title = asString(parsed.value.title);
          let head = asString(parsed.value.head);
          let base = asString(parsed.value.base);
          if (!title || !head || !base) return errorReply(422, 'title, head and base are required');
          if (head.includes(':')) head = head.split(':').at(-1) as string;
          if (base.includes(':')) base = base.split(':').at(-1) as string;
          const headSha = store.resolveRef(repo, head);
          const baseSha = store.resolveRef(repo, base);
          if (!headSha || !baseSha) return errorReply(422, 'head or base ref does not exist');
          if (headSha === baseSha) return errorReply(422, 'No commits between head and base');
          const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (existing) return errorReply(422, 'A pull request already exists for this head');
          const pull = store.createPull(repo, title, asString(parsed.value.body) ?? '', head, headSha, base, baseSha);
          return jsonReply(201, pullView(repo, pull));
        }
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (rest.length === 2 && method === 'GET') {
        if (!pull) return errorReply(404, 'Not Found');
        return jsonReply(200, pullView(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return errorReply(404, 'Not Found');
        return jsonReply(200, store.pullFiles(pull));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return errorReply(404, 'Not Found');
        if (pull.merged) return errorReply(405, 'Pull request has already been merged');
        if (pull.state === 'closed') return errorReply(405, 'Pull request is closed');
        if (store.pullConflict(repo, pull)) return errorReply(405, 'Merge conflict');
        const sha = store.mergePull(repo, pull);
        if (!sha) return errorReply(405, 'Merge conflict');
        return jsonReply(200, { merged: true, sha, message: `Merge pull request #${pull.number}` });
      }
      return errorReply(404, 'Not Found');
    }
  }

  return errorReply(404, 'Not Found');
}

function parseCommitView(data: Uint8Array): { author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } } {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const headers = text.slice(0, blank < 0 ? text.length : blank);
  const parse = (key: string): { name: string; email: string; date: string } => {
    for (const line of headers.split('\n')) {
      if (!line.startsWith(`${key} `)) continue;
      const value = line.slice(key.length + 1);
      const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(value);
      if (!match) return { name: value, email: '', date: '' };
      return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
    }
    return { name: '', email: '', date: '' };
  };
  return { author: parse('author'), committer: parse('committer') };
}

export type { GitObjectType };
