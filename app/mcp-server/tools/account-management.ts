import { AccountingRepository, ChartOfAccount } from '@app/data/accounting-repository.js';
import { AsciiHierarcy, formatCurrency, renderAsciiHierarchy } from '@app/formatter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineManageManyAccountsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('manageManyAccounts', {
    title: 'Multi-purpose account management tools',
    description: 'Use this tool to create and or update (upsert) multiple accounts at once.',
    inputSchema: {
      accounts: z.array(z.object({
        code: z.number(),
        name: z.string(),
        normalBalance: z.enum(['debit', 'credit']),
        controlCode: z.number().optional().describe('Optional control account code to set the account hierarchy'),
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

    accountLoop:
    for (const account of params.accounts) {
      const existingAccount = existingAccounts.find(a => a.code === account.code);
      if (existingAccount) {
        results.push(`Existing account ${account.code} (${existingAccount.name}) already exists with balance of ${formatCurrency(existingAccount.balance ?? 0, userConfig)} and normal balance ${existingAccount.normalBalance}, skipping.`);
        continue accountLoop;
      } else {
        await repo.addAccount(account.code, account.name, account.normalBalance);
        results.push(`New account ${account.code} (${account.name}) has been created with normal balance ${account.normalBalance}.`);
      }
    }

    return {
      content: [{
        type: 'text',
        text: results.join('\n'),
      }],
    };
  });
}

export function defineRenameAccountMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('renameAccount', {
    title: 'Change an account name',
    description: "Set an account's display name.",
    inputSchema: { code: z.number(), name: z.string() },
  }, async function (params) {
    const existingAccount = await repo.getAccountByCode(params.code);
    if (!existingAccount) {
      return { content: [{ type: 'text', text: `Account with code ${params.code} does not exist.` }] };
    }
    try {
      await repo.setAccountName(params.code, params.name);
    }
    catch (error) {
      return { content: [{ type: 'text', text: `Error renaming account: ${(error as Error).message}` }] };
    }
    return { content: [{ type: 'text', text: `Account ${params.code} renamed from "${existingAccount.name}" to "${params.name}". Normal balance: ${existingAccount.normalBalance}.` }] };
  });
}

export function defineSetControlAccountMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('setControlAccount', {
    title: 'Set control account',
    description: 'Control account determines the account hierarchy and reporting structure.',
    inputSchema: {
      accountCode: z.number(),
      controlAccountCode: z.number(),
    },
  }, async function (params) {
    const account = await repo.getAccountByCode(params.accountCode);
    if (!account) {
      return { content: [{ type: 'text', text: `Account with code ${params.accountCode} does not exist.` }] };
    }
    const controlAccount = await repo.getAccountByCode(params.controlAccountCode);
    if (!controlAccount) {
      return { content: [{ type: 'text', text: `Control account with code ${params.controlAccountCode} does not exist.` }] };
    }
    if (params.accountCode === params.controlAccountCode) {
      return { content: [{ type: 'text', text: 'An account cannot be its own control account.' }] };
    }
    try {
      await repo.setControlAccount(params.accountCode, params.controlAccountCode);
    }
    catch (error) {
      return { content: [{ type: 'text', text: `Error setting control account: ${(error as Error)?.message}` }] };
    }
    return { content: [{ type: 'text', text: `Account ${params.accountCode} (${account.name}, normal balance: ${account.normalBalance}) control account set to ${params.controlAccountCode} (${controlAccount.name}, normal balance: ${controlAccount.normalBalance}).` }] };
  });
}

export function defineGetChartOfAccountsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('getChartOfAccounts', {
    title: 'Get hierarchical chart of accounts',
    description: 'Return a hierarchical chart of accounts.',
    inputSchema: {},
  }, async function () {
    const userConfig = await repo.getUserConfig();
    const chartOfAccountToAsciiHierarchy = function (account: ChartOfAccount): AsciiHierarcy {
      return {
        label: `${account.code} ${account.name} (Balance: ${formatCurrency(account.balance ?? 0, userConfig)}, Normal: ${account.normalBalance})`,
        children: account.children ? account.children.map(chartOfAccountToAsciiHierarchy) : [],
      };
    };
    const roots = await repo.getChartOfAccounts();
    const asciiHierarchyNode = {
      label: 'Chart of Accounts',
      children: roots.map(chartOfAccountToAsciiHierarchy),
    };
    const asciiHierarchy = renderAsciiHierarchy(asciiHierarchyNode);
    return { content: [{ type: 'text', text: asciiHierarchy }] };
  });
}

