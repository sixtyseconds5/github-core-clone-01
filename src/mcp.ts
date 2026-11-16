// MCP (streamable HTTP, JSON-RPC 2.0): the modern `server/discover` era
// (2026-07-28) with the legacy `initialize` handshake as a fallback, plus the
// six canonical tools the suite requires. No session handling: the server never
// hands out an Mcp-Session-Id, so the client's close() is a no-op.

import { VIEWER } from './scenario.ts';
import type { ForgeStore, Repo } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The branch containing the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`unknown tool ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`missing required argument ${required}`);
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  const repo = repoName ? store.getRepo(owner, repoName) : undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (store.getRepo(VIEWER.login, repoNameArg)) return errorResult('Repository already exists');
      const created = store.createRepo(VIEWER.login, repoNameArg, {
        private: typeof args.private === 'boolean' ? args.private : false,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return textResult(repoJson(created));
    }
    case 'get_repo': {
      if (!repo) return errorResult('Repository not found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      if (!repo) return errorResult('Repository not found');
      const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return textResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      if (!repo) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return textResult({ issues });
    }
    case 'create_pull_request': {
      if (!repo) return errorResult('Repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (!headSha || !baseSha) return errorResult('head or base ref does not exist');
      const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha);
      return textResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } });
    }
    case 'merge_pull_request': {
      if (!repo) return errorResult('Repository not found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return errorResult('Pull request not found');
      if (pull.merged) return textResult({ number: pull.number, merged: true, state: 'closed', sha: pull.mergeCommitSha });
      if (store.pullConflict(repo, pull)) return errorResult('Merge conflict');
      const sha = store.mergePull(repo, pull);
      if (!sha) return errorResult('Merge conflict');
      return textResult({ number: pull.number, merged: true, state: 'closed', sha });
    }
    case 'get_issue': {
      if (!repo) return errorResult('Repository not found');
      const number = Number(args.issue_number);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (!issue) return errorResult('Issue not found');
      return textResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_pull_requests': {
      if (!repo) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .map((pull) => ({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } }));
      return textResult({ pull_requests: pulls });
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

function handleRequest(store: ForgeStore, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = (request.id ?? null) as Json;
  const method = request.method as string | undefined;
  const isNotification = id === null || id === undefined;
  const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const respondError = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (typeof method !== 'string') {
    return isNotification ? null : respondError(-32600, 'Invalid Request');
  }
  if (method.startsWith('notifications/')) return null;

  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      return respond({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = params.protocolVersion as string | undefined;
      const protocolVersion = offered && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return respond({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return respond({});
    }
    case 'tools/list': {
      return respond({
        tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
    }
    case 'tools/call': {
      const toolName = params.name as string | undefined;
      if (!toolName) return respondError(-32602, 'tool name is required');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === toolName)) return respondError(-32602, `unknown tool ${toolName}`);
      const result = callTool(store, toolName, args);
      return respond(result);
    }
    default:
      return respondError(-32601, `Method not found: ${method}`);
  }
}

export function handleMcp(store: ForgeStore, bodyText: string): { status: number; body: Buffer | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    const error = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    return { status: 400, body: Buffer.from(JSON.stringify(error), 'utf8') };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: Record<string, unknown>[] = [];
  for (const request of requests) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const response = handleRequest(store, request as Record<string, unknown>);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return { status: 202, body: null };
  const body = Array.isArray(parsed) ? responses : responses[0];
  return { status: 200, body: Buffer.from(JSON.stringify(body), 'utf8') };
}
