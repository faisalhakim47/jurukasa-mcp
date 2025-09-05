import { AccountingRepository } from '@app/data/accounting-repository.js';
import { renderAsciiTable } from '@app/formatter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineExecuteSqlQueryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('executeSqlQuery', {
    title: 'Execute SQL query',
    description: 'Execute a raw SQLite query against the accounting database. The sqlite-accounting-schema://schema resource must be provided as context/reference when generating queries to ensure correct table structure and column names.',
    inputSchema: {
      query: z.string(),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    },
  }, async function (params) {
    try {
      const results = await repo.rawSql(params.query, params.params);
      
      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Query executed successfully, but returned no results.',
          }],
        };
      }

      // Format results as ASCII table
      const headers = Object.keys(results[0]);
      const rows = results.map(row => Object.values(row).map(val => String(val)));
      const table = renderAsciiTable(headers, rows);
      
      return {
        content: [{
          type: 'text',
          text: `Query executed successfully. Results:\n${table}`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error executing SQL query: ${(error as Error).message}`,
        }],
      };
    }
  });
}
