import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineSetManyAccountTagsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('SetManyAccountTags', {
    title: 'Set many account tags',
    description: 'Set tags for multiple accounts. Each account can have multiple tags. Use the account-tags://reference resource to see all valid tag values.',
    inputSchema: {
      accountTags: z.array(z.object({
        accountCode: z.number(),
        tag: z.string().describe('Tag is predefined string enum constant. Get valid tags from the account-tags://reference resource.'),
      })),
    },
  }, async function (params) {
    if (params.accountTags.length === 0) {
      const allAccounts = await repo.getManyAccounts({});
      if (allAccounts.length === 0) {
        return {
          content: [{ type: 'text', text: 'No accounts exist in the system. Consider setting up an initial chart of accounts using the ManageManyAccounts tool.' }],
        };
      } else {
        return {
          content: [{ type: 'text', text: 'No tagged accounts provided, nothing to do.' }],
        };
      }
    }

    try {
      await repo.SetManyAccountTags(params.accountTags.map(ta => ({ accountCode: ta.accountCode, tag: ta.tag })));
      const results = params.accountTags.map(ta => `Account ${ta.accountCode} tagged with "${ta.tag}".`);
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

export function defineUnSetManyAccountTagsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('UnsetManyAccountTags', {
    title: 'Unset many account tags',
    description: 'Remove tags from multiple accounts. Use the account-tags://reference resource to see all valid tag values.',
    inputSchema: {
      accountTags: z.array(z.object({
        accountCode: z.number(),
        tag: z.string(),
      })),
    },
  }, async function (params) {
    if (params.accountTags.length === 0) {
      return {
        content: [{ type: 'text', text: 'No tagged accounts provided, nothing to do.' }],
      };
    }

    try {
      await repo.UnsetManyAccountTags(params.accountTags.map(ta => ({ accountCode: ta.accountCode, tag: ta.tag })));
      const results = params.accountTags.map(ta => `Tag "${ta.tag}" removed from account ${ta.accountCode}.`);
      return {
        content: [{ type: 'text', text: results.join('\n') }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error unsetting account tags: ${(error as Error).message}` }],
      };
    }
  });
}
