import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

const ALLOWED_CONFIG_KEYS = [
  'Business Name',
  'Business Type',
  'Currency Code',
  'Currency Decimals',
  'Locale',
  'Fiscal Year Start Month'
] as const;

export function defineSetConfigMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('setConfig', {
    title: 'Set user configuration',
    description: 'Update multiple user configuration settings. Only predefined keys are allowed.',
    inputSchema: {
      configs: z.array(z.object({
        key: z.enum(ALLOWED_CONFIG_KEYS),
        value: z.string(),
      })),
    },
  }, async function (params) {
    try {
      const now = Date.now();
      const updates = params.configs.map(config => 
        repo.sql`
          INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at)
          VALUES (${config.key}, ${config.value}, ${now}, ${now})
        `
      );

      await Promise.all(updates);

      const updateMessages = params.configs.map(config => 
        `${config.key} = "${config.value}"`
      ).join(', ');

      return {
        content: [{
          type: 'text',
          text: `Configuration updated: ${updateMessages}`
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error updating configuration: ${(error as Error).message}`
        }],
      };
    }
  });
}

export function defineGetConfigMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('getConfig', {
    title: 'Get user configuration',
    description: 'Retrieve all user configuration settings.',
  }, async function (params) {
    // params is unused for getConfig as it takes no input
    try {
      const result = await repo.sql`
        SELECT key, value FROM user_config ORDER BY key
      `;

      const rows = result as { key: string; value: string }[];
      
      if (rows.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No configuration settings found.'
          }],
        };
      }

      const configText = rows.map(row => `${row.key}: "${row.value}"`).join('\n');

      return {
        content: [{
          type: 'text',
          text: `User Configuration:\n${configText}`
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error retrieving configuration: ${(error as Error).message}`
        }],
      };
    }
  });
}
