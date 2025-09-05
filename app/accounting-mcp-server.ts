import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountingRepository, ChartOfAccount } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';
import { AsciiHierarcy, formatCurrency, renderAsciiHierarchy, renderAsciiTable } from '@app/formatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function readSqliteAccountingSchema(): Promise<string> {
  const schemaPath = join(__dirname, './data/sqlite-accounting-schema-llm.sql');
  const schemaText = await readFile(schemaPath, { encoding: 'utf-8' });
  return schemaText;
}

export function createAccountingMcpServer(repo: AccountingRepository): McpServer {
  const server = new McpServer({
    version: '1.0.0',
    name: 'jurukasa-accounting-mcp',
    title: 'Jurukasa Accounting MCP',
  });

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

  server.registerTool('ensureManyAccountsExist', {
    title: 'Ensure many accounts exist',
    description: 'Check that multiple accounts exist by each code, creating any that are missing. This tool does not update existing accounts.',
    inputSchema: {
      accounts: z.array(z.object({
        code: z.number(),
        name: z.string(),
        normalBalance: z.enum(['debit', 'credit']),
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
        results.push(`Existing account ${account.code} (${existingAccount.name}) already exists with balance of ${formatCurrency(account.normalBalance ?? 0, userConfig)}, skipping.`);
        continue accountLoop;
      } else {
        await repo.addAccount(account.code, account.name, account.normalBalance);
        results.push(`New account ${account.code} (${account.name}) has been created.`);
      }
    }

    return {
      content: [{
        type: 'text',
        text: results.join('\n'),
      }],
    };
  });

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
    return { content: [{ type: 'text', text: `Account ${params.code} renamed from "${existingAccount.name}" to "${params.name}".` }] };
  });

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
    return { content: [{ type: 'text', text: `Account ${params.accountCode} (${account.name}) control account set to ${params.controlAccountCode} (${controlAccount.name}).` }] };
  });

  server.registerTool('getHierarchicalChartOfAccounts', {
    title: 'Get hierarchical chart of accounts',
    description: 'Return a hierarchical chart of accounts.',
    inputSchema: {},
  }, async function () {
    const userConfig = await repo.getUserConfig();
    const chartOfAccountToAsciiHierarchy = function (account: ChartOfAccount): AsciiHierarcy {
      return {
        label: `${account.code} ${account.name} (Balance: ${formatCurrency(account.balance ?? 0, userConfig)})`,
        children: account.children ? account.children.map(chartOfAccountToAsciiHierarchy) : [],
      };
    };
    const roots = await repo.getHierarchicalChartOfAccounts();
    const asciiHierarchyNode = {
      label: 'Chart of Accounts',
      children: roots.map(chartOfAccountToAsciiHierarchy),
    };
    const asciiHierarchy = renderAsciiHierarchy(asciiHierarchyNode);
    return { content: [{ type: 'text', text: asciiHierarchy }] };
  });

  server.registerTool('getManyAccounts', {
    title: 'Get many accounts',
    description: 'Fetch multiple accounts by their codes, names, tags, or account control code. The query is inclusive OR across the provided filters.',
    inputSchema: {
      codes: z.array(z.number()).optional(),
      names: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      controlAccountCodes: z.number().optional(),
    },
  }, async function (params) {
    const userConfig = await repo.getUserConfig();
    const accounts = await repo.getManyAccounts({
      codes: params.codes,
      names: params.names,
      tags: params.tags,
      controlAccountCodes: params.controlAccountCodes ? [params.controlAccountCodes] : undefined,
    });
    if (accounts.length === 0) {
      return { content: [{ type: 'text', text: 'No accounts found matching the provided filters.' }] };
    }
    const lines = accounts.map(a => `${a.code} ${a.name} (Balance: ${formatCurrency(a.balance ?? 0, userConfig)})`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

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

  server.registerTool('draftJournalEntry', {
    title: 'Draft journal entry',
    description: 'Create a draft journal entry with specified date, description, and lines. Returns the journal entry reference number.',
    inputSchema: {
      date: z.string(),
      description: z.string(),
      lines: z.array(z.object({
        accountCode: z.number(),
        amount: z.number(),
        type: z.enum(['debit', 'credit']),
      })),
    },
  }, async function (params) {
    try {
      const entryTime = new Date(params.date).getTime();
      const journalLines = params.lines.map(line => ({
        accountCode: line.accountCode,
        debit: line.type === 'debit' ? line.amount : 0,
        credit: line.type === 'credit' ? line.amount : 0,
      }));

      const journalEntryRef = await repo.draftJournalEntry({
        entryTime,
        description: params.description,
        lines: journalLines,
      });

      return {
        content: [{
          type: 'text',
          text: `Draft journal entry created with reference ${journalEntryRef} for date ${params.date}.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating draft journal entry: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('updateJournalEntry', {
    title: 'Update journal entry',
    description: 'Update an existing journal entry with new date, description, and/or lines.',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string(),
      description: z.string(),
      lines: z.array(z.object({
        accountCode: z.number(),
        amount: z.number(),
        type: z.enum(['debit', 'credit']),
      })),
    },
  }, async function (params) {
    try {
      const entryTime = new Date(params.date).getTime();
      const journalLines = params.lines.map(line => ({
        accountCode: line.accountCode,
        debit: line.type === 'debit' ? line.amount : 0,
        credit: line.type === 'credit' ? line.amount : 0,
      }));

      await repo.updateJournalEntry(params.journalEntryRef, {
        entryTime,
        description: params.description,
        lines: journalLines,
      });

      return {
        content: [{
          type: 'text',
          text: `Journal entry ${params.journalEntryRef} updated successfully.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error updating journal entry: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('postJournalEntry', {
    title: 'Post journal entry',
    description: 'Post a draft journal entry to make it final. Optionally specify a post date (defaults to current date).',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string().optional(),
    },
  }, async function (params) {
    try {
      const postTime = params.date ? new Date(params.date).getTime() : Date.now();
      await repo.postJournalEntry(params.journalEntryRef, postTime);

      return {
        content: [{
          type: 'text',
          text: `Journal entry ${params.journalEntryRef} posted successfully.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error posting journal entry: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('deleteManyJournalEntryDrafts', {
    title: 'Delete many journal entry drafts',
    description: 'Delete multiple draft journal entries that have not been posted yet.',
    inputSchema: {
      journalEntryRefs: z.array(z.number()),
    },
  }, async function (params) {
    if (params.journalEntryRefs.length === 0) {
      return {
        content: [{ type: 'text', text: 'No journal entry references provided, nothing to delete.' }],
      };
    }

    try {
      await repo.deleteManyJournalEntryDrafts(params.journalEntryRefs);
      const results = params.journalEntryRefs.map(ref => `Draft journal entry ${ref} deleted.`);
      return {
        content: [{
          type: 'text',
          text: results.join('\n'),
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error deleting journal entry drafts: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('reverseJournalEntry', {
    title: 'Reverse journal entry',
    description: 'Create a reversal journal entry for a posted journal entry. The reversal will swap debits and credits of the original entry.',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string(),
      description: z.string().optional(),
    },
  }, async function (params) {
    try {
      const reversalTime = new Date(params.date).getTime();
      const reversalRef = await repo.reverseJournalEntry(params.journalEntryRef, reversalTime, params.description);
      
      return {
        content: [{
          type: 'text',
          text: `Reversal journal entry created with reference ${reversalRef} for original entry ${params.journalEntryRef}.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error reversing journal entry: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('getLatestTrialBalance', {
    title: 'Get latest trial balance',
    description: 'Fetch the latest trial balance as of a specific date, defaulting to the most recent if no date is provided. Date is in ISO format (YYYY-MM-DD HH:MM:SS).',
    inputSchema: {
      fromDate: z.string().optional(),
    },
  }, async function (params) {
    const userConfig = await repo.getUserConfig();
    const report = await repo.getLatestTrialBalance(params.fromDate);
    if (!report) {
      return {
        content: [{ type: 'text', text: 'No trial balance reports found.' }],
      };
    }

    const headers = ['Account Code', 'Account Name', 'Normal Balance', 'Debit', 'Credit'];
    const rows = report.lines.map(line => [
      line.accountCode.toString(),
      line.accountName,
      line.normalBalance,
      formatCurrency(line.debit, userConfig),
      formatCurrency(line.credit, userConfig),
    ]);
    const table = renderAsciiTable(headers, rows);

    return {
      content: [{
        type: 'text',
        text: `Trial Balance Report (${new Date(report.reportTime).toISOString()})\n${table}`,
      }],
    };
  });

  server.registerTool('getLatestBalanceSheet', {
    title: 'Get latest balance sheet',
    description: 'Fetch the latest balance sheet as of a specific date, defaulting to the most recent if no date is provided. Date is in ISO format (YYYY-MM-DD HH:MM:SS).',
    inputSchema: {
      fromDate: z.string().optional(),
    },
  }, async function (params) {
    const userConfig = await repo.getUserConfig();
    const report = await repo.getLatestBalanceSheet(params.fromDate);
    if (!report) {
      return {
        content: [{ type: 'text', text: 'No balance sheet reports found.' }],
      };
    }

    const headers = ['Classification', 'Category', 'Account Code', 'Account Name', 'Amount'];
    const rows = report.lines.map(line => [
      line.classification,
      line.category,
      line.accountCode.toString(),
      line.accountName,
      formatCurrency(line.amount, userConfig),
    ]);

    // Calculate classification totals
    const classificationTotals = new Map<string, number>();
    for (const line of report.lines) {
      const current = classificationTotals.get(line.classification) || 0;
      classificationTotals.set(line.classification, current + line.amount);
    }

    // Add total rows for each classification
    const totalRows: string[][] = [];
    for (const [classification, total] of classificationTotals) {
      totalRows.push([
        `TOTAL ${classification.toUpperCase()}`,
        '',
        '',
        '',
        formatCurrency(total, userConfig),
      ]);
    }

    const allRows = [...rows, ...totalRows];
    const table = renderAsciiTable(headers, allRows);

    return {
      content: [{
        type: 'text',
        text: `Balance Sheet Report (${new Date(report.reportTime).toISOString()})\n${table}`,
      }],
    };
  });

  server.registerTool('generateFinancialReport', {
    title: 'Generate financial report',
    description: 'Generate Trial Balance and Balance Sheet snapshots for the current date/time.',
    inputSchema: {},
  }, async function () {
    const reportTime = Date.now();
    const reportId = await repo.generateFinancialReport(reportTime);

    return {
      content: [{
        type: 'text',
        text: `Financial report generated with ID ${reportId} at ${new Date(reportTime).toISOString()}. Trial Balance and Balance Sheet snapshots have been created.`,
      }],
    };
  });

  server.registerTool('executeSqlQuery', {
    title: 'Execute SQL query',
    description: 'Execute a raw SQL query against the accounting database. The sqlite-accounting-schema://schema resource should be provided as context/reference when generating queries to ensure correct table structure and column names.',
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

  return server;
}
