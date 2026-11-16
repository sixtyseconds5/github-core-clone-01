// GraphQL: a small parser and executor for the query/mutation surface the suite
// exercises (viewer, repository, node, __type, issue/pull-request connections,
// create/close/merge mutations). Global ids are opaque base64 strings, never the
// plain database id or issue number. Unknown fields answer HTTP 200 with an errors
// array naming the field; an unknown repository answers data.repository = null.

import { VIEWER } from './scenario.ts';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';

// ------------------------------------------------------------------ values

type Value =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly Value[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<readonly [string, Value]> };

type Selection =
  | { readonly kind: 'field'; readonly alias: string | undefined; readonly name: string; readonly args: ReadonlyArray<readonly [string, Value]>; readonly selections: readonly Selection[] }
  | { readonly kind: 'inlineFragment'; readonly typeCondition: string | undefined; readonly selections: readonly Selection[] }
  | { readonly kind: 'fragmentSpread'; readonly name: string };

interface Operation {
  readonly type: 'query' | 'mutation' | 'subscription';
  readonly name: string | undefined;
  readonly variableDefinitions: ReadonlyArray<{ readonly name: string; readonly defaultValue: Value | undefined }>;
  readonly selections: readonly Selection[];
}

interface Fragment {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly Selection[];
}

// ------------------------------------------------------------------ tokenizer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') { isFloat = true; while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1; }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:=!$@&|...'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = this.next().value as Operation['type'];
      const nextToken = this.peek();
      if (nextToken.kind === 'name') name = this.next().value;
    }
    const variableDefinitions: { name: string; defaultValue: Value | undefined }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const varToken = this.next();
        if (varToken.kind !== 'punct' || varToken.value !== '$') throw new Error('expected $ in variable definition');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | undefined;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variableDefinitions.push({ name: varName, defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, variableDefinitions, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nextToken.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: undefined, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: [string, Value][] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push([argName, this.parseValue()]);
      }
    }
    // Directives, if any, are skipped.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
          if (t.kind === 'eof') break;
        }
      }
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: [string, Value][] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push([fieldName, this.parseValue()]);
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in GraphQL value');
  }
}

// ------------------------------------------------------------------ ids

function encodeId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeId(id: string): string | undefined {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeId(`repo:${repo.id}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId(`issue:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeId(`pull:${repo.id}:${pull.number}`);
}

function cursorFor(number: number): string {
  return encodeId(`cursor:${number}`);
}

function numberFromCursor(cursor: string | null | undefined): number | undefined {
  if (!cursor) return undefined;
  const decoded = decodeId(cursor);
  if (!decoded) return undefined;
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

// ------------------------------------------------------------------ values

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

function resolveValue(value: Value, variables: Record<string, unknown>): Plain {
  switch (value.kind) {
    case 'variable': {
      const found = variables[value.name];
      return (found === undefined ? null : found) as Plain;
    }
    case 'string': return value.value;
    case 'int': case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: { [key: string]: Plain } = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ node model

type NodeValue =
  | { readonly kind: 'viewer' }
  | { readonly kind: 'user'; readonly login: string }
  | { readonly kind: 'repository'; readonly repo: Repo }
  | { readonly kind: 'issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly kind: 'pull'; readonly repo: Repo; readonly pull: Pull }
  | { readonly kind: 'issueConnection'; readonly repo: Repo; readonly issues: Issue[]; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly kind: 'pullConnection'; readonly repo: Repo; readonly pulls: Pull[] }
  | { readonly kind: 'fileConnection'; readonly files: { path: string }[] }
  | { readonly kind: 'pageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly kind: 'commentEdge'; readonly id: string; readonly body: string }
  | { readonly kind: 'comment'; readonly id: string; readonly body: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'createIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly kind: 'closeIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly kind: 'createPullPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly kind: 'mergePullPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly kind: 'addCommentPayload'; readonly id: string; readonly body: string }
  | { readonly kind: 'type'; readonly name: string }
  | { readonly kind: 'typeField'; readonly name: string }
  | { readonly kind: 'enumValue'; readonly name: string }
  | { readonly kind: 'branchRef'; readonly name: string }
  | { readonly kind: 'scalar'; readonly value: Plain };

const TYPE_NAMES: Record<string, string> = {
  viewer: 'Viewer',
  user: 'User',
  repository: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  issueConnection: 'IssueConnection',
  pullConnection: 'PullRequestConnection',
  fileConnection: 'PullRequestFileConnection',
  pageInfo: 'PageInfo',
  commentEdge: 'IssueCommentEdge',
  comment: 'IssueComment',
  file: 'File',
  createIssuePayload: 'CreateIssuePayload',
  closeIssuePayload: 'CloseIssuePayload',
  createPullPayload: 'CreatePullRequestPayload',
  mergePullPayload: 'MergePullRequestPayload',
  addCommentPayload: 'AddCommentPayload',
  type: '__Type',
  typeField: '__Field',
  enumValue: '__EnumValue',
  branchRef: 'Ref',
  scalar: 'String',
};

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'CODE', 'TOPIC'];

interface Executor {
  readonly store: ForgeStore;
  readonly errors: { message: string }[];
  readonly fragments: Map<string, Fragment>;
  readonly variables: Record<string, unknown>;
}

function findRepoByGlobalId(store: ForgeStore, id: string): Repo | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;
  const match = /^repo:(\d+)$/.exec(decoded);
  if (!match) return undefined;
  const wanted = Number.parseInt(match[1] as string, 10);
  return [...store.repos.values()].find((repo) => repo.id === wanted);
}

function findIssueByGlobalId(store: ForgeStore, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;
  const match = /^issue:(\d+):(\d+)$/.exec(decoded);
  if (!match) return undefined;
  const repoId = Number.parseInt(match[1] as string, 10);
  const number = Number.parseInt(match[2] as string, 10);
  const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
  const issue = repo?.issues.find((candidate) => candidate.number === number);
  return repo && issue ? { repo, issue } : undefined;
}

function findPullByGlobalId(store: ForgeStore, id: string): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;
  const match = /^pull:(\d+):(\d+)$/.exec(decoded);
  if (!match) return undefined;
  const repoId = Number.parseInt(match[1] as string, 10);
  const number = Number.parseInt(match[2] as string, 10);
  const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
  const pull = repo?.pulls.find((candidate) => candidate.number === number);
  return repo && pull ? { repo, pull } : undefined;
}

function argsMap(selection: Extract<Selection, { kind: 'field' }>, variables: Record<string, unknown>): Record<string, Plain> {
  const out: Record<string, Plain> = {};
  for (const [name, value] of selection.args) out[name] = resolveValue(value, variables);
  return out;
}

function resolveField(exec: Executor, parent: NodeValue, selection: Extract<Selection, { kind: 'field' }>): NodeValue | undefined {
  const args = argsMap(selection, exec.variables);
  const store = exec.store;
  const unknown = (): undefined => {
    exec.errors.push({ message: `Cannot query field "${selection.name}" on type "${TYPE_NAMES[parent.kind]}".` });
    return undefined;
  };

  switch (parent.kind) {
    case 'viewer': {
      if (selection.name === 'login') return { kind: 'scalar', value: VIEWER.login };
      return unknown();
    }
    case 'user': {
      if (selection.name === 'login') return { kind: 'scalar', value: parent.login };
      return unknown();
    }
    case 'repository': {
      const repo = parent.repo;
      switch (selection.name) {
        case 'id': return { kind: 'scalar', value: repoGlobalId(repo) };
        case 'databaseId': return { kind: 'scalar', value: repo.id };
        case 'name': return { kind: 'scalar', value: repo.name };
        case 'nameWithOwner': return { kind: 'scalar', value: repo.fullName };
        case 'owner': return { kind: 'user', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = store.defaultTip(repo);
          return tip ? { kind: 'branchRef', name: repo.defaultBranch } : { kind: 'scalar', value: null };
        }
        case 'viewerPermission': return { kind: 'scalar', value: 'ADMIN' };
        case 'hasIssuesEnabled': return { kind: 'scalar', value: true };
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = repo.issues.find((candidate) => candidate.number === number);
          return issue ? { kind: 'issue', repo, issue } : { kind: 'scalar', value: null };
        }
        case 'issues': {
          let issues = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (states && states.length) {
            const wanted = new Set(states.map((state) => state.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          } else {
            issues = issues.filter((issue) => issue.state === 'open');
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = (orderBy?.direction ?? 'DESC').toUpperCase();
          issues.sort((a, b) => {
            const byCreated = direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq;
            return byCreated !== 0 ? byCreated : direction === 'ASC' ? a.number - b.number : b.number - a.number;
          });
          const afterNumber = numberFromCursor(args.after as string | null | undefined);
          if (afterNumber !== undefined) {
            const index = issues.findIndex((issue) => issue.number === afterNumber);
            if (index >= 0) issues = issues.slice(index + 1);
          }
          const first = (args.first as number | undefined) ?? 100;
          const page = issues.slice(0, first);
          const hasNextPage = issues.length > first;
          const endCursor = page.length ? cursorFor(page[page.length - 1]?.number as number) : null;
          return { kind: 'issueConnection', repo, issues: page, hasNextPage, endCursor };
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const first = (args.first as number | undefined) ?? 100;
          return { kind: 'pullConnection', repo, pulls: pulls.slice(0, first) };
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          return pull ? { kind: 'pull', repo, pull } : { kind: 'scalar', value: null };
        }
        default: return unknown();
      }
    }
    case 'issue': {
      const issue = parent.issue;
      switch (selection.name) {
        case 'id': return { kind: 'scalar', value: issueGlobalId(parent.repo, issue) };
        case 'number': return { kind: 'scalar', value: issue.number };
        case 'title': return { kind: 'scalar', value: issue.title };
        case 'body': return { kind: 'scalar', value: issue.body };
        case 'state': return { kind: 'scalar', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'createdAt': return { kind: 'scalar', value: issue.createdAt };
        default: return unknown();
      }
    }
    case 'pull': {
      const pull = parent.pull;
      switch (selection.name) {
        case 'id': return { kind: 'scalar', value: pullGlobalId(parent.repo, pull) };
        case 'number': return { kind: 'scalar', value: pull.number };
        case 'title': return { kind: 'scalar', value: pull.title };
        case 'body': return { kind: 'scalar', value: pull.body };
        case 'state': return { kind: 'scalar', value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'merged': return { kind: 'scalar', value: pull.merged };
        case 'headRefName': return { kind: 'scalar', value: pull.headRef };
        case 'baseRefName': return { kind: 'scalar', value: pull.baseRef };
        case 'mergeable': {
          const mergeable = store.pullConflict(parent.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
          return { kind: 'scalar', value: mergeable };
        }
        case 'files': {
          const files = store.pullFiles(pull).map((file) => ({ path: file.filename }));
          const first = (args.first as number | undefined) ?? 100;
          return { kind: 'fileConnection', files: files.slice(0, first) };
        }
        default: return unknown();
      }
    }
    case 'issueConnection': {
      if (selection.name === 'nodes') return { kind: 'scalar', value: parent.issues.map((issue) => ({ kind: 'issue', repo: parent.repo, issue }) as NodeValue) };
      if (selection.name === 'pageInfo') {
        return { kind: 'pageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor };
      }
      if (selection.name === 'totalCount') return { kind: 'scalar', value: parent.issues.length };
      return unknown();
    }
    case 'pullConnection': {
      if (selection.name === 'nodes') return { kind: 'scalar', value: parent.pulls.map((pull) => ({ kind: 'pull', repo: parent.repo, pull }) as NodeValue) };
      if (selection.name === 'pageInfo') return { kind: 'pageInfo', hasNextPage: false, endCursor: null };
      if (selection.name === 'totalCount') return { kind: 'scalar', value: parent.pulls.length };
      return unknown();
    }
    case 'fileConnection': {
      if (selection.name === 'nodes') return { kind: 'scalar', value: parent.files.map((file) => ({ kind: 'file', path: file.path }) as NodeValue) };
      if (selection.name === 'pageInfo') return { kind: 'pageInfo', hasNextPage: false, endCursor: null };
      return unknown();
    }
    case 'file': {
      if (selection.name === 'path') return { kind: 'scalar', value: parent.path };
      return unknown();
    }
    case 'createIssuePayload':
    case 'closeIssuePayload': {
      if (selection.name === 'issue') return { kind: 'issue', repo: parent.repo, issue: parent.issue };
      return unknown();
    }
    case 'createPullPayload':
    case 'mergePullPayload': {
      if (selection.name === 'pullRequest') return { kind: 'pull', repo: parent.repo, pull: parent.pull };
      return unknown();
    }
    case 'addCommentPayload': {
      if (selection.name === 'commentEdge') return { kind: 'commentEdge', id: parent.id, body: parent.body };
      return unknown();
    }
    case 'pageInfo': {
      if (selection.name === 'hasNextPage') return { kind: 'scalar', value: parent.hasNextPage };
      if (selection.name === 'hasPreviousPage') return { kind: 'scalar', value: false };
      if (selection.name === 'endCursor') return { kind: 'scalar', value: parent.endCursor };
      if (selection.name === 'startCursor') return { kind: 'scalar', value: parent.endCursor };
      return unknown();
    }
    case 'commentEdge': {
      if (selection.name === 'node') return { kind: 'comment', id: parent.id, body: parent.body };
      return unknown();
    }
    case 'comment': {
      if (selection.name === 'id') return { kind: 'scalar', value: parent.id };
      if (selection.name === 'body') return { kind: 'scalar', value: parent.body };
      return unknown();
    }
    case 'branchRef': {
      if (selection.name === 'name') return { kind: 'scalar', value: parent.name };
      return unknown();
    }
    case 'type': {
      if (selection.name === 'name') return { kind: 'scalar', value: parent.name };
      if (selection.name === 'fields') {
        const fields = parent.name === 'Issue' ? ISSUE_FIELDS : parent.name === 'PullRequest' ? PULL_FIELDS : parent.name === 'Repository' ? REPO_FIELDS : [];
        return { kind: 'scalar', value: fields.map((name) => ({ kind: 'typeField', name }) as NodeValue) };
      }
      if (selection.name === 'enumValues') {
        const values = parent.name === 'SearchType' ? SEARCH_ENUM : [];
        return { kind: 'scalar', value: values.map((name) => ({ kind: 'enumValue', name }) as NodeValue) };
      }
      return unknown();
    }
    case 'typeField': {
      if (selection.name === 'name') return { kind: 'scalar', value: parent.name };
      return unknown();
    }
    case 'enumValue': {
      if (selection.name === 'name') return { kind: 'scalar', value: parent.name };
      return unknown();
    }
    case 'scalar': {
      return unknown();
    }
  }
}

function executeSelections(exec: Executor, parent: NodeValue, selections: readonly Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelections(exec, parent, fragment.selections));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const typeName = TYPE_NAMES[parent.kind];
      if (!selection.typeCondition || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(exec, parent, selection.selections));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolveField(exec, parent, selection);
    if (resolved === undefined) continue;
    out[key] = materialize(exec, resolved, selection.selections);
  }
  return out;
}

function materialize(exec: Executor, value: NodeValue, selections: readonly Selection[]): unknown {
  if (value.kind === 'scalar') {
    const raw = value.value;
    if (Array.isArray(raw)) {
      return raw.map((item) => {
        if (item && typeof item === 'object' && 'kind' in (item as Record<string, unknown>)) {
          return executeSelections(exec, item as NodeValue, selections);
        }
        return item;
      });
    }
    return raw;
  }
  if (selections.length === 0) return null;
  return executeSelections(exec, value, selections);
}

function executeRootField(exec: Executor, selection: Extract<Selection, { kind: 'field' }>, isMutation: boolean): unknown {
  const args = argsMap(selection, exec.variables);
  const store = exec.store;
  if (!isMutation) {
    switch (selection.name) {
      case 'viewer': return executeSelections(exec, { kind: 'viewer' }, selection.selections);
      case 'repository': {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return executeSelections(exec, { kind: 'repository', repo }, selection.selections);
      }
      case 'node': {
        const id = args.id as string | undefined;
        if (!id) return null;
        const repo = findRepoByGlobalId(store, id);
        if (repo) return executeSelections(exec, { kind: 'repository', repo }, selection.selections);
        const issue = findIssueByGlobalId(store, id);
        if (issue) return executeSelections(exec, { kind: 'issue', repo: issue.repo, issue: issue.issue }, selection.selections);
        const pull = findPullByGlobalId(store, id);
        if (pull) return executeSelections(exec, { kind: 'pull', repo: pull.repo, pull: pull.pull }, selection.selections);
        return null;
      }
      case '__type': {
        const name = args.name as string | undefined;
        if (!name || !['Issue', 'PullRequest', 'Repository', 'SearchType', 'Viewer', 'User'].includes(name)) return null;
        return executeSelections(exec, { kind: 'type', name }, selection.selections);
      }
      default: {
        exec.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
        return undefined;
      }
    }
  }
  // Mutations.
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (selection.name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : undefined;
      if (!repo) {
        exec.errors.push({ message: 'repository not found' });
        return null;
      }
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return executeSelections(exec, { kind: 'createIssuePayload', repo, issue }, selection.selections);
    }
    case 'closeIssue': {
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : undefined;
      if (!found) {
        exec.errors.push({ message: 'issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      return executeSelections(exec, { kind: 'closeIssuePayload', repo: found.repo, issue: found.issue }, selection.selections);
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : undefined;
      if (!repo) {
        exec.errors.push({ message: 'repository not found' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = store.resolveRef(repo, headRef);
      const baseSha = store.resolveRef(repo, baseRef);
      if (!headSha || !baseSha) {
        exec.errors.push({ message: 'head or base ref does not exist' });
        return null;
      }
      const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, headSha, baseRef, baseSha);
      return executeSelections(exec, { kind: 'createPullPayload', repo, pull }, selection.selections);
    }
    case 'mergePullRequest': {
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : undefined;
      if (!found) {
        exec.errors.push({ message: 'pull request not found' });
        return null;
      }
      if (!found.pull.merged && !store.pullConflict(found.repo, found.pull)) store.mergePull(found.repo, found.pull);
      return executeSelections(exec, { kind: 'mergePullPayload', repo: found.repo, pull: found.pull }, selection.selections);
    }
    case 'addComment': {
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(store, input.subjectId) : undefined;
      if (!found) {
        exec.errors.push({ message: 'subject not found' });
        return null;
      }
      const commentId = store.nextCommentId();
      found.issue.comments.push({ id: commentId, body: String(input.body ?? '') });
      return executeSelections(exec, { kind: 'addCommentPayload', id: encodeId(`comment:${found.repo.id}:${found.issue.number}:${commentId}`), body: String(input.body ?? '') }, selection.selections);
    }
    default: {
      exec.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".` });
      return undefined;
    }
  }
}

function executeOperation(store: ForgeStore, operation: Operation, variables: Record<string, unknown>, fragments: Map<string, Fragment>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const exec: Executor = { store, errors: [], fragments, variables: { ...variables } };
  for (const def of operation.variableDefinitions) {
    if (exec.variables[def.name] === undefined && def.defaultValue !== undefined) {
      exec.variables[def.name] = resolveValue(def.defaultValue, exec.variables);
    }
  }
  const isMutation = operation.type === 'mutation';
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment) Object.assign(data, executeSelections(exec, { kind: 'viewer' }, fragment.selections));
      continue;
    }
    if (selection.kind === 'inlineFragment') continue;
    const key = selection.alias ?? selection.name;
    const value = executeRootField(exec, selection, isMutation);
    if (value !== undefined) data[key] = value;
  }
  return { data, errors: exec.errors };
}

export function handleGraphQL(store: ForgeStore, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'malformed JSON body' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const request of requests) {
    const query = (request as { query?: unknown }).query;
    const variables = ((request as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    const operationName = (request as { operationName?: unknown }).operationName as string | undefined;
    if (typeof query !== 'string') {
      results.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    let document: { operations: Operation[]; fragments: Map<string, Fragment> };
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      results.push({ errors: [{ message: (err as Error).message }] });
      continue;
    }
    const operation = operationName
      ? document.operations.find((candidate) => candidate.name === operationName)
      : document.operations[0];
    if (!operation) {
      results.push({ errors: [{ message: 'operation not found' }] });
      continue;
    }
    const { data, errors } = executeOperation(store, operation, variables, document.fragments);
    const result: Record<string, unknown> = { data };
    if (errors.length) result.errors = errors;
    results.push(result);
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}
