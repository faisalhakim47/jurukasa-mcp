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

  server.registerTool('ensure_many_accounts_exist', {
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

  server.registerTool('rename_account', {
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

  server.registerTool('set_control_account', {
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

  server.registerTool('get_hierarchical_chart_of_accounts', {
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
    const asciiHierarchy = renderAsciiHierarchy(asciiHierarchyNode, '', false, true);
    return { content: [{ type: 'text', text: asciiHierarchy }] };
  });

  server.registerTool('get_many_accounts', {
    title: 'Get many accounts',
    description: 'Fetch multiple accounts by their codes, names, tags, or account control code. The query is inclusive OR across the provided filters.',
    inputSchema: {
      codes: z.array(z.number()).optional(),
      names: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      controlAccountCodes: z.number().optional(),
    },
  }, async function (params) {
    if ((!params.codes || params.codes.length === 0) &&
      (!params.names || params.names.length === 0) &&
      (!params.tags || params.tags.length === 0) &&
      !params.controlAccountCodes) {
      return { content: [{ type: 'text', text: 'No filters provided, please specify at least one of codes, names, tags, or controlAccountCodes.' }] };
    }
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

  server.registerTool('set_many_account_tags', {
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
      return {
        content: [{ type: 'text', text: 'No tagged accounts provided, nothing to do.' }],
      };
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

  server.registerTool('unset_many_account_tags', {
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

  server.registerTool('draft_journal_entry', {
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
    if (params.lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'No journal entry lines provided.' }],
      };
    }

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
          text: `Draft journal entry created with reference ${journalEntryRef}.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating draft journal entry: ${(error as Error).message}` }],
      };
    }
  });

  server.registerTool('update_journal_entry', {
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

  server.registerTool('post_journal_entry', {
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

  server.registerTool('execute_sql_query', {
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
