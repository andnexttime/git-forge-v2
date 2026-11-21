// Model Context Protocol over the Streamable HTTP transport at /mcp: JSON-RPC 2.0, revision
// 2026-07-28 via server/discover (supportedVersions is a non-empty list of YYYY-MM-DD revisions),
// with initialize + notifications/initialized answered for a pre-discover client. tools/list
// offers the six tools github-mcp-server documents; the tools act on the same store as REST, so a
// repository or issue created over MCP reads back over /api/v3 as the same object.
//
// Contract points the suite judges: an unknown tool is JSON-RPC -32602 or -32601, never HTTP 500;
// a tools/call missing a required argument is isError:true or -32602; a body that is not JSON is
// HTTP 400 with -32700; a call with no Authorization header is HTTP 401 (enforced by the server
// before this handler runs); two concurrent tools/call answers keep their own JSON-RPC ids.

import {
  VIEWER,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  listIssues,
  mergePull,
  repoJson,
  issueJson,
  pullJson,
  type Store,
} from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const SERVER_NAME = 'forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list answer, built once: two calls answer the same list, byte for byte. */
const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  const owner = asString(args.owner ?? args.owner_login ?? VIEWER);
  const repoName = asString(args.repo ?? args.repository ?? args.name);
  switch (name) {
    case 'create_repo': {
      const made = createRepo(store, asString(args.name), args.private === true, asString(args.description));
      if ('error' in made) return { result: toolErrorResult(made.error) };
      return { result: toolResult(repoJson(made.repo)) };
    }
    case 'get_repo': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return { result: toolErrorResult(`Repository ${owner}/${repoName} not found`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return { result: toolErrorResult(`Repository ${owner}/${repoName} not found`) };
      const made = createIssue(store, repo, asString(args.title), asString(args.body), []);
      if ('error' in made) return { result: toolErrorResult(made.error) };
      return { result: toolResult(issueJson(repo, made.issue)) };
    }
    case 'list_issues': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return { result: toolErrorResult(`Repository ${owner}/${repoName} not found`) };
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
      const issues = listIssues(repo, { state, perPage: 100 });
      return { result: toolResult(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return { result: toolErrorResult(`Repository ${owner}/${repoName} not found`) };
      const made = createPull(store, repo, asString(args.title), asString(args.body), asString(args.head), asString(args.base));
      if ('error' in made) return { result: toolErrorResult(made.error) };
      return { result: toolResult(pullJson(repo, made.pull)) };
    }
    case 'merge_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return { result: toolErrorResult(`Repository ${owner}/${repoName} not found`) };
      const number = asNumber(args.pull_number ?? args.number);
      if (number === null) return { error: { code: -32602, message: 'Missing required argument: pull_number' } };
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { result: toolErrorResult(`Pull request #${number} not found`) };
      const merged = mergePull(store, repo, pull);
      if ('error' in merged) return { result: toolErrorResult(merged.error) };
      return { result: toolResult(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body (already read as text). Returns the HTTP status and the JSON body to
 * send (null for a notification, which answers with an empty 202).
 */
export function handleMcp(store: Store, bodyText: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  const ok = (result: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return ok({
      supportedVersions: [MCP_REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? ((params as Record<string, unknown>).protocolVersion as string) : MCP_REVISION;
    return ok({
      protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : MCP_REVISION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok(TOOLS_LIST);
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, toolName, args);
    if ('error' in outcome) return fail(outcome.error.code, outcome.error.message);
    return ok(outcome.result);
  }
  void isNotification;
  return fail(-32601, `Method not found: ${method}`);
}
