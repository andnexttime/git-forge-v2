// GraphQL v4 for the documents gh and github-mcp-server send: a small tokenizer + recursive
// descent parser for the query language subset those documents use (operations, variables,
// aliases, arguments, inline input objects, inline enum lists, inline fragments on a type,
// __type introspection), and an executor over the forge store. No schema library, no clock.
//
// Supported root fields: Query.viewer, Query.repository, Query.node, Query.__type and the
// mutations createIssue, closeIssue, createPullRequest, mergePullRequest, addComment. An unknown
// field is a GraphQL error naming it (HTTP 200 with an errors array), never an HTTP error; an
// unknown repository is data.repository = null with no errors.

import {
  VIEWER,
  addComment,
  commentGid,
  createIssue,
  createPull,
  decodeGid,
  getIssue,
  getPull,
  getRepo,
  gid,
  issueGid,
  listIssues,
  listPulls,
  mergePull,
  pullFiles,
  pullGid,
  pullMergeable,
  repoGid,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------- tokenizer

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

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
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables: Array<{ name: string; type: string }> = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            const type = this.parseType();
            if (this.peek().kind === 'punct' && this.peek().value === '=') {
              this.next();
              this.parseValue();
            }
            variables.push({ name: varName, type });
          }
          this.expectPunct(')');
        }
        operations.push({ kind, name, variables, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // the type condition
        fragments.set(fragName, this.parseSelections());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (token.kind !== 'name') throw new Error(`expected a type, got ${JSON.stringify(token.value)}`);
    let out = token.value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelections(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
      }
      // A named fragment spread: inline it at execution time; keep the name in the condition slot.
      const name = this.expectName();
      return { kind: 'fragment', typeCondition: `...${name}`, selections: [] };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite's documents; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: GqlSelection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelections();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

export function parseGraphQL(query: string): GqlDocument {
  return new Parser(tokenize(query)).parseDocument();
}

// --------------------------------------------------------------------------- values

type Variables = Readonly<Record<string, unknown>>;

function valueOf(value: GqlValue, variables: Variables): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: GqlField, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// --------------------------------------------------------------------------- introspection data

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'assignees', 'milestone'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'url', 'createdAt', 'author', 'labels'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'COMMIT', 'REPOSITORY', 'USER', 'DISCUSSION'];

// --------------------------------------------------------------------------- executor

interface Ctx {
  store: Store;
}

type AnyObj = Record<string, unknown> & { __typename: string };

function issueNode(ctx: Ctx, repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullNode(ctx: Ctx, repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userNode(): AnyObj {
  return { __typename: 'User', login: VIEWER };
}

function resolveRepoById(ctx: Ctx, id: string): Repo | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  const owner = decoded.key.slice(0, slash);
  const name = decoded.key.slice(slash + 1);
  return getRepo(ctx.store, owner, name) ?? null;
}

function resolveIssueById(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const lastColon = decoded.key.lastIndexOf(':');
  if (lastColon < 0) return null;
  const repoPart = decoded.key.slice(0, lastColon);
  const number = Number(decoded.key.slice(lastColon + 1));
  const slash = repoPart.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = getRepo(ctx.store, repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (repo === undefined) return null;
  const issue = getIssue(repo, number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function resolvePullById(ctx: Ctx, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const lastColon = decoded.key.lastIndexOf(':');
  if (lastColon < 0) return null;
  const repoPart = decoded.key.slice(0, lastColon);
  const number = Number(decoded.key.slice(lastColon + 1));
  const slash = repoPart.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = getRepo(ctx.store, repoPart.slice(0, slash), repoPart.slice(slash + 1));
  if (repo === undefined) return null;
  const pull = getPull(repo, number);
  if (pull === undefined) return null;
  return { repo, pull };
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): AnyObj {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const first = asInt(args.first);
  const after = typeof args.after === 'string' && args.after !== '' ? args.after : null;
  let list = [...repo.issues];
  if (states !== null && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  // Default order is creation order (number ascending); CREATED_AT DESC reverses it.
  if (orderBy !== null && String(orderBy.field ?? '').toUpperCase() === 'CREATED_AT' && String(orderBy.direction ?? '').toUpperCase() === 'DESC') {
    list.sort((a, b) => b.number - a.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  if (after !== null) {
    const decoded = decodeGid(after);
    const cursorNumber = decoded !== null && decoded.kind === 'cursor' ? Number(decoded.key) : NaN;
    if (Number.isInteger(cursorNumber)) {
      list = list.filter((issue) => issue.number > cursorNumber);
    }
  }
  const page = first === null ? list : list.slice(0, first);
  const hasNextPage = first !== null && list.length > first;
  const endCursor = page.length === 0 ? null : gid('cursor', String(page[page.length - 1]?.number ?? ''));
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((issue) => issueNode(ctx, repo, issue)),
    __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

/** Resolve one field of an object; throws on a resolver failure (caught by the executor). */
function resolveField(ctx: Ctx, parent: AnyObj, field: GqlField, variables: Variables): unknown {
  const args = argsOf(field, variables);
  const type = parent.__typename;
  if (field.name === '__typename') return type;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return userNode();
      if (field.name === 'repository') {
        const repo = getRepo(ctx.store, asString(args.owner), asString(args.name));
        if (repo === undefined) return null;
        return { __typename: 'Repository', __repo: repo };
      }
      if (field.name === 'node') {
        const id = asString(args.id);
        const decoded = decodeGid(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = resolveRepoById(ctx, id);
          if (repo === null) return null;
          return { __typename: 'Repository', __repo: repo };
        }
        if (decoded.kind === 'Issue') {
          const found = resolveIssueById(ctx, id);
          if (found === null) return null;
          return issueNode(ctx, found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = resolvePullById(ctx, id);
          if (found === null) return null;
          return pullNode(ctx, found.repo, found.pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = asString(args.name);
        if (name === 'Issue') return { __typename: '__Type', __typeName: 'Issue', __fields: ISSUE_FIELDS, __enumValues: [] };
        if (name === 'PullRequest') return { __typename: '__Type', __typeName: 'PullRequest', __fields: PULL_REQUEST_FIELDS, __enumValues: [] };
        if (name === 'Repository') return { __typename: '__Type', __typeName: 'Repository', __fields: REPOSITORY_FIELDS, __enumValues: [] };
        if (name === 'SearchType') return { __typename: '__Type', __typeName: 'SearchType', __fields: [], __enumValues: SEARCH_TYPE_VALUES };
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = resolveRepoById(ctx, asString(input.repositoryId));
        if (repo === null) throw new Error('repository not found');
        const made = createIssue(ctx.store, repo, asString(input.title), asString(input.body), []);
        if ('error' in made) throw new Error(made.error);
        return { __typename: 'CreateIssuePayload', issue: issueNode(ctx, repo, made.issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolveIssueById(ctx, asString(input.issueId));
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueNode(ctx, found.repo, found.issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = resolveRepoById(ctx, asString(input.repositoryId));
        if (repo === null) throw new Error('repository not found');
        const made = createPull(ctx.store, repo, asString(input.title), '', asString(input.headRefName), asString(input.baseRefName));
        if ('error' in made) throw new Error(made.error);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx, repo, made.pull) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolvePullById(ctx, asString(input.pullRequestId));
        if (found === null) throw new Error('pull request not found');
        const merged = mergePull(ctx.store, found.repo, found.pull);
        if ('error' in merged) throw new Error(merged.error);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx, found.repo, found.pull) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolveIssueById(ctx, asString(input.subjectId));
        if (found === null) throw new Error('issue not found');
        const made = addComment(found.repo, found.issue.number, asString(input.body));
        if ('error' in made) throw new Error(made.error);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: commentGid(found.repo, found.issue, made.comment), body: made.comment.body },
          },
        };
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return VIEWER;
      if (field.name === 'id') return gid('User', VIEWER);
      if (field.name === 'name') return VIEWER;
      break;
    }
    case 'Repository': {
      const repo = parent.__repo as Repo;
      if (field.name === 'id') return repoGid(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return userNode();
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'private') return repo.isPrivate;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field.name === 'createdAt') return '2025-01-01T00:00:00Z';
      if (field.name === 'issue') {
        const number = asInt(args.number);
        if (number === null) return null;
        const issue = getIssue(repo, number);
        return issue === undefined ? null : issueNode(ctx, repo, issue);
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, args);
      if (field.name === 'pullRequests') {
        const first = asInt(args.first);
        const list = listPulls(repo, { state: 'open', perPage: first ?? 30 });
        return { __typename: 'PullRequestConnection', __nodes: list.map((pull) => pullNode(ctx, repo, pull)) };
      }
      if (field.name === 'pullRequest') {
        const number = asInt(args.number);
        if (number === null) return null;
        const pull = getPull(repo, number);
        return pull === undefined ? null : pullNode(ctx, repo, pull);
      }
      break;
    }
    case 'Issue': {
      const issue = parent.__issue as Issue;
      const repo = parent.__repo as Repo;
      if (field.name === 'id') return issueGid(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt') return '2025-01-01T00:00:00Z';
      if (field.name === 'updatedAt') return '2025-01-01T00:00:00Z';
      if (field.name === 'author') return userNode();
      if (field.name === 'labels') return { __typename: 'LabelConnection', __nodes: issue.labels.map((name) => ({ __typename: 'Label', name })) };
      if (field.name === 'comments') return { __typename: 'IssueCommentConnection', __nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: commentGid(repo, issue, comment), body: comment.body })) };
      break;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.__nodes as unknown[];
      if (field.name === 'pageInfo') return parent.__pageInfo as AnyObj;
      if (field.name === 'totalCount') return (parent.__nodes as unknown[]).length;
      break;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.__nodes as unknown[];
      break;
    }
    case 'PullRequest': {
      const pull = parent.__pull as Pull;
      const repo = parent.__repo as Repo;
      if (field.name === 'id') return pullGid(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return pullMergeable(repo, pull);
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (field.name === 'mergedAt') return pull.mergedAt;
      if (field.name === 'mergeCommit') return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'createdAt') return '2025-01-01T00:00:00Z';
      if (field.name === 'author') return userNode();
      if (field.name === 'files') {
        const first = asInt(args.first);
        const files = pullFiles(repo, pull);
        const page = first === null ? files : files.slice(0, first);
        return { __typename: 'PullRequestChangedFileConnection', __nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })) };
      }
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return parent.__nodes as unknown[];
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path as string;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name as string;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage as boolean;
      if (field.name === 'endCursor') return (parent.endCursor as string | null) ?? null;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return parent.__typeName as string;
      if (field.name === 'kind') return (parent.__enumValues as string[]).length > 0 ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') return (parent.__fields as string[]).map((name) => ({ __typename: '__Field', name }));
      if (field.name === 'enumValues') return (parent.__enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name }));
      break;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name as string;
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name as string;
      break;
    }
    case 'Label': {
      if (field.name === 'name') return parent.name as string;
      break;
    }
    case 'LabelConnection': {
      if (field.name === 'nodes') return parent.__nodes as unknown[];
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return parent.id as string;
      if (field.name === 'body') return parent.body as string;
      break;
    }
    case 'IssueCommentConnection': {
      if (field.name === 'nodes') return parent.__nodes as unknown[];
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return parent.node as AnyObj;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue as AnyObj;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest as AnyObj;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return parent.commentEdge as AnyObj;
      break;
    }
    case 'Commit': {
      if (field.name === 'oid') return parent.oid as string;
      break;
    }
  }
  return undefined;
}

/** Execute one operation document against the store. */
export function executeGraphQL(store: Store, query: string, variables: Variables = {}, operationName?: string): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: (string | number)[] }> } {
  const errors: Array<{ message: string; path?: (string | number)[] }> = [];
  let doc: GqlDocument;
  try {
    doc = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName !== undefined ? doc.operations.find((op) => op.name === operationName) ?? doc.operations[0] : doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { store };
  const root: AnyObj = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(ctx, root, operation.selections, variables, doc.fragments, errors, []);
  return { data, errors };
}

function executeSelections(
  ctx: Ctx,
  parent: AnyObj,
  selections: GqlSelection[],
  variables: Variables,
  fragments: Map<string, GqlSelection[]>,
  errors: Array<{ message: string; path?: (string | number)[] }>,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition.startsWith('...')) {
        const named = fragments.get(selection.typeCondition.slice(3));
        if (named !== undefined) Object.assign(out, executeSelections(ctx, parent, named, variables, fragments, errors, path));
        continue;
      }
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(ctx, parent, selection.selections, variables, fragments, errors, path));
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(ctx, parent, field, variables);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (field.selections.length > 0) {
      if (value === null) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item, index) =>
          item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
            ? executeSelections(ctx, item as AnyObj, field.selections, variables, fragments, errors, [...path, key, index])
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelections(ctx, value as AnyObj, field.selections, variables, fragments, errors, [...path, key]);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
