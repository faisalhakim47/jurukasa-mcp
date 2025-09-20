import { AccountingRepository, ChartOfAccount } from '@app/data/accounting-repository.js';
import { AsciiHierarcy, formatCurrency, renderAsciiHierarchy } from '@app/formatter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineManageManyAccountsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('ManageManyAccounts', {
    title: 'Multi-purpose account management tool',
    description: 'Use this tool to create and or update (upsert) multiple accounts at once. This tool will create new accounts if they do not exist. This tool will update existing account names.',
    inputSchema: {
      accounts: z.array(z.object({
        code: z.number().describe('Primary identifier of an account.'),
        name: z.string(),
        normalBalance: z.enum(['debit', 'credit']),
        controlAccountCode: z.number().optional().describe('If set, set control account code for chart of account hierarchy. Default is NULL.'),
        deactivate: z.boolean().optional().describe('If true, deactivate/close the account. Default is false. Balance must be zero to deactivate/close an account.'),
      })),
    },
  }, async function (params) {
    if (params.accounts.length === 0) {
      return {
        content: [{ type: 'text', text: 'No accounts provided, nothing to do.' }],
      };
    }

    const userConfig = await repo.getUserConfig();
    const existingAccounts = await repo.getManyAccountsByCodes(params.accounts.map(a => a.code));

    const results: Array<string> = [];

    for (const account of params.accounts) {
      const existingAccount = existingAccounts.find(a => a.code === account.code);
      if (existingAccount) {
        if (existingAccount.normalBalance === account.normalBalance) {
          try {
            await repo.updateAccount(account.code, {
              name: account.name,
              controlCode: account.controlAccountCode,
              deactivate: account.deactivate,
            });
            const resultTexts: Array<string> = [];
            if (typeof account.name === 'string' && existingAccount.name !== account.name) {
              resultTexts.push(`the account's name has been updated from "${existingAccount.name}" to "${account.name}"`);
            }
            if (typeof account.controlAccountCode === 'number' && existingAccount.controlAccountCode !== account.controlAccountCode) {
              resultTexts.push(`the account's control code has been updated from "${existingAccount.controlAccountCode === null ? 'None' : existingAccount.controlAccountCode}" to "${account.controlAccountCode}"`);
            }
            if (typeof account.deactivate === 'boolean' && existingAccount.isActive !== !account.deactivate) {
              if (account.deactivate) {
                resultTexts.push(`the account has been deactivated/closed. Final balance was ${formatCurrency(existingAccount.balance ?? 0, userConfig)}.`);
              }
              else {
                resultTexts.push('the account has been re-activated/re-opened.');
              }
            }
            if (resultTexts.length === 0) {
              results.push(`account ${account.code} "${account.name}" was found but no changes were made.`);
            }
            else {
              results.push(`account ${account.code} "${account.name}" has been updated: ${resultTexts.join('; ')}`);
            }
          }
          catch (error) {
            results.push(`error updating account ${account.code} "${account.name}": ${(error as Error).message}`);
          }
        }
        else {
          results.push(`existing account ${account.code} "${account.name}" was found but normal balance mismatch (existing: ${existingAccount.normalBalance}, provided: ${account.normalBalance}). No changes were made.`);
        }
      }
      else {
        try {
          await repo.addAccount(account.code, account.name, account.normalBalance);
          // Set control account if provided
          if (typeof account.controlAccountCode === 'number') {
            await repo.updateAccount(account.code, { controlCode: account.controlAccountCode });
          }
          results.push(`new account ${account.code} "${account.name}" has been created with normal balance ${account.normalBalance}.`);
        }
        catch (error) {
          results.push(`Error creating account ${account.code} "${account.name}": ${(error as Error).message}`);
        }
      }
    }

    return {
      content: [{ type: 'text', text: `# Account Management Result\n- ${results.join('\n- ')}` }],
    };
  });
}

export function defineViewChartOfAccountsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('ViewChartOfAccounts', {
    title: 'Get complete chart of accounts',
    description: 'This tool will return complete information including code, name, balance, and normal balance for all accounts in a hierarchical structure.',
    inputSchema: {
      showInactive: z.boolean().optional().default(false).describe('If true, include inactive accounts in the chart of accounts. Default is false.'),
    },
  }, async function (params) {
    const userConfig = await repo.getUserConfig();
    const chartOfAccountToAsciiHierarchy = function (account: ChartOfAccount): AsciiHierarcy {
      return {
        label: `account ${account.code} "${account.name}" — (balance: ${formatCurrency(account.balance ?? 0, userConfig)}, normal balance: ${account.normalBalance})`,
        children: account.children ? account.children.map(chartOfAccountToAsciiHierarchy) : [],
      };
    };
    const roots = await repo.ViewChartOfAccounts({ includeInactive: params.showInactive });
    const asciiHierarchy = renderAsciiHierarchy({
      label: '# Chart of Accounts',
      children: roots.map(chartOfAccountToAsciiHierarchy),
    });
    return {
      content: [{ type: 'text', text: asciiHierarchy }],
    };
  });
}
