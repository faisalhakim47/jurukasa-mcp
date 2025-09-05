import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineSetManyAccountTagsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('setManyAccountTags', {
    title: 'Set many account tags',
    description: 'Set tags for multiple accounts. Each account can have multiple tags.',
    inputSchema: {
      taggedAccounts: z.array(z.object({
        code: z.number(),
        tag: z.string(),
      })),
    },
  }, async function (params) {
    if (params.taggedAccounts.length === 0) {
      const allAccounts = await repo.getManyAccounts({});
      if (allAccounts.length === 0) {
        return {
          content: [{ type: 'text', text: 'No accounts exist in the system. Consider setting up an initial chart of accounts using the ensureManyAccountsExist tool.' }],
        };
      } else {
        return {
          content: [{ type: 'text', text: 'No tagged accounts provided, nothing to do.' }],
        };
      }
    }

    try {
      await repo.setManyAccountTags(params.taggedAccounts.map(ta => ({ accountCode: ta.code, tag: ta.tag })));
      const results = params.taggedAccounts.map(ta => `Account ${ta.code} tagged with "${ta.tag}".`);
      return {
        content: [{
          type: 'text',
          text: results.join('\n'),
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error setting account tags: ${(error as Error).message}` }],
      };
    }
  });
}

export function defineUnsetManyAccountTagsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('unsetManyAccountTags', {
    title: 'Unset many account tags',
    description: 'Remove tags from multiple accounts.',
    inputSchema: {
      taggedAccounts: z.array(z.object({
        code: z.number(),
        tag: z.string(),
      })),
    },
  }, async function (params) {
    if (params.taggedAccounts.length === 0) {
      return {
        content: [{ type: 'text', text: 'No tagged accounts provided, nothing to do.' }],
      };
    }

    try {
      await repo.unsetManyAccountTags(params.taggedAccounts.map(ta => ({ accountCode: ta.code, tag: ta.tag })));
      const results = params.taggedAccounts.map(ta => `Tag "${ta.tag}" removed from account ${ta.code}.`);
      return {
        content: [{
          type: 'text',
          text: results.join('\n'),
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error unsetting account tags: ${(error as Error).message}` }],
      };
    }
  });
}
