// MCP client manager. Connects to user-configured stdio MCP servers
// (e.g. Atlassian via `npx -y mcp-remote https://mcp.atlassian.com/v1/sse`)
// and exposes their tools to the report generator's prompt-driven tool loop.

import { truncate } from './util.js';

const connections = new Map(); // name -> { client, tools }

async function sdk() {
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    return { Client, StdioClientTransport };
  } catch (e) {
    throw new Error(`MCP SDK unavailable (${e.message}). Run \`npm install\` in the app directory.`);
  }
}

async function open(server) {
  const { Client, StdioClientTransport } = await sdk();
  if (!server?.name || !server?.command) {
    throw new Error('MCP server entries need at least {"name", "command"}');
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...process.env, ...(server.env || {}) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'git-radar', version: '0.1.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools: tools || [] };
}

/** Connect any not-yet-connected servers. Returns per-server status. */
export async function connectServers(servers = []) {
  const statuses = [];
  for (const server of servers) {
    if (connections.has(server.name)) {
      statuses.push({ name: server.name, ok: true, toolCount: connections.get(server.name).tools.length });
      continue;
    }
    try {
      const conn = await open(server);
      connections.set(server.name, conn);
      statuses.push({ name: server.name, ok: true, toolCount: conn.tools.length });
    } catch (e) {
      statuses.push({ name: server.name, ok: false, error: e.message });
    }
  }
  return statuses;
}

/** Flattened tool list across connected servers, names qualified as "server.tool". */
export function listAllTools() {
  const out = [];
  for (const [serverName, conn] of connections) {
    for (const t of conn.tools) {
      out.push({
        name: `${serverName}.${t.name}`,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      });
    }
  }
  return out;
}

/** Call "server.tool" with arguments; returns the text content, truncated for prompts. */
export async function callTool(qualifiedName, args = {}) {
  const dot = qualifiedName.indexOf('.');
  if (dot === -1) throw new Error(`Tool name must be "server.tool", got "${qualifiedName}"`);
  const serverName = qualifiedName.slice(0, dot);
  const toolName = qualifiedName.slice(dot + 1);
  const conn = connections.get(serverName);
  if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);

  const result = await conn.client.callTool({ name: toolName, arguments: args });
  const text = (result.content || [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`))
    .join('\n');
  if (result.isError) throw new Error(`Tool ${qualifiedName} errored: ${truncate(text, 500)}`);
  return truncate(text, 8000);
}

/** One-off connectivity test used by the Settings screen. */
export async function testServer(server) {
  let conn;
  try {
    conn = await open(server);
    return { ok: true, tools: conn.tools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (conn) await conn.client.close().catch(() => {});
  }
}

export async function disconnectAll() {
  for (const [name, conn] of connections) {
    await conn.client.close().catch(() => {});
    connections.delete(name);
  }
}
