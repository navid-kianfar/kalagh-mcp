#!/usr/bin/env node
/**
 * Read-only smoke test against a running provider, through a real MCP client
 * over stdio: lists the tools, then calls status, channels_list, chats_list,
 * messages_list and events_recent. The server is started with
 * KALAGH_READ_ONLY=true, so no tool that writes is even listed.
 *
 *   KALAGH_API_URL=… KALAGH_API_KEY=… [KALAGH_TRANSPORT=ws KALAGH_WS_URL=…] node scripts/smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', process.env.SMOKE_ENTRY ?? 'dist/index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, KALAGH_READ_ONLY: 'true' },
  stderr: 'inherit',
});
const client = new Client({ name: 'kalagh-mcp-smoke', version: '1.0.0' });
await client.connect(transport);

const text = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${text(result)}`);
  return JSON.parse(text(result));
};

const { tools } = await client.listTools();
const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
console.log(`tools: ${tools.length} (writes listed: ${writes.length ? writes.join(', ') : 'none'})`);

const status = await call('status');
console.log(`status: transport=${status.transport} schema=${status.schemaSource} events=${JSON.stringify(status.events)} health=${JSON.stringify(status.provider.health)} info=${JSON.stringify(status.provider.info)}`);

const channels = await call('channels_list', { page: 1, limit: 5 });
const list = channels.channels ?? [];
console.log(`channels_list: total=${channels.total} first=${list[0] ? `${list[0].id} state=${list[0].state}` : 'none'}`);

if (list[0]) {
  const chats = await call('chats_list', { channelId: list[0].id, page: 1, limit: 1 });
  const chat = (chats.chats ?? [])[0];
  console.log(`chats_list: total=${chats.total} first=${chat ? chat.id : 'none'}`);
  if (chat) {
    const messages = await call('messages_list', { channelId: list[0].id, chatId: chat.id, limit: 2 });
    console.log(`messages_list: got ${(messages.messages ?? []).length}, nextCursor=${messages.nextCursor ? 'yes' : 'no'}`);
  }
}

const bad = await client.callTool({ name: 'channels_list', arguments: { page: 1, channelID: 'typo' } });
console.log(`unknown field refused: ${bad.isError ? text(bad) : 'NO — accepted'}`);

if (tools.some((t) => t.name === 'events_recent')) {
  const events = await call('events_recent', { waitSeconds: 3 });
  console.log(`events_recent: lastSeq=${events.lastSeq}, ${events.events.length} buffered`);
}
await client.close();
