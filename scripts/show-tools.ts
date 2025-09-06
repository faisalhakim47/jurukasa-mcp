import { Client } from '@modelcontextprotocol/sdk/client';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';
import { createAccountingMcpServer, SqliteAccountingRepository } from '@app/index.js';

const serverTransport = new MemoryTransport();
const clientTransport = new MemoryTransport();
clientTransport._paired = serverTransport;
serverTransport._paired = clientTransport;

const repo = new SqliteAccountingRepository(':memory:');
const server = createAccountingMcpServer(repo);
const client = new Client({ name: 'test-client', version: '1.0.0' });

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

const tools = await client.listTools();

console.log('JuruKasa MCP Tools:', JSON.stringify(tools));

await Promise.all([
  client.close(),
  server.close(),
]);
