import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readSqliteAccountingSchema(): Promise<string> {
  const schemaPath = join(__dirname, '../../data/sqlite-accounting-schema-llm.sql');
  const schemaText = await readFile(schemaPath, { encoding: 'utf-8' });
  return schemaText;
}

export function defineSqliteAccountingSchemaMCPResource(server: McpServer) {
  // Expose the SQLite schema as a static resource that LLM clients can fetch
  // Note: MCP clients should read this resource (uri: sqlite-accounting-schema://schema) and provide
  // it as context/reference when asking the LLM to generate or validate SQL for `sql.query`.
  server.registerResource(
    'sqlite-accounting-schema',
    'sqlite-accounting-schema://schema',
    {
      title: 'SQLite accounting database schema (LLM reference)',
      description: 'Full SQLite schema for the accounting database. MCP clients should fetch this resource and supply it as reference/context when generating SQL for the sql.query tool.',
      mimeType: 'text/sql',
    },
    async function () {
      const schemaText = await readSqliteAccountingSchema();
      return {
        contents: [{
          uri: 'sqlite-accounting-schema://schema',
          mimeType: 'text/sql',
          text: schemaText,
        }],
      };
    }
  );
}
