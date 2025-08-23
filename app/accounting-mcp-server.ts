import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

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
      description:
        'Full SQLite schema for the accounting database. MCP clients should fetch this resource and supply it as reference/context when generating SQL for the sql.query tool.',
      mimeType: 'text/sql',
    },
    async function () {
      const schemaText = await readSqliteAccountingSchema();
      return {
        contents: [{ uri: 'sqlite-accounting-schema://schema', mimeType: 'text/sql', text: schemaText }],
      };
    }
  );

  server.registerTool('account.add', {
    title: 'Add account',
    description: 'Create a new account with a numeric code, name and normal balance (debit|credit).',
    inputSchema: {
      code: z.number(),
      name: z.string(),
      normalBalance: z.enum(['debit', 'credit']),
    },
    outputSchema: {},
  }, async function (params) {
    await repo.addAccount(params.code, params.name, params.normalBalance);
    return {
      content: [{
        type: 'text',
        text: `Account ${params.code} added.`,
      }],
      // Provide structuredContent because an (empty) outputSchema was declared;
      // this satisfies SDK validation which requires structured content when an output schema exists.
      structuredContent: {
        code: params.code,
        name: params.name,
        normalBalance: params.normalBalance,
      },
    };
  });

  // Implement the rest of the accounting tools using the McpServer API
  server.registerTool('account.setName', {
    title: 'Set account name',
    description: "Set an account's display name.",
    inputSchema: { code: z.number(), name: z.string() },
  }, async function (params) {
    await repo.setAccountName(params.code, params.name);
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('account.setControl', {
    title: 'Set control account',
    description: "Set an account's control account code.",
    inputSchema: { code: z.number(), controlAccountCode: z.number() },
  }, async function (params) {
    await repo.setControlAccount(params.code, params.controlAccountCode);
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('account.getHierarchy', {
    title: 'Get hierarchical chart of accounts',
    description: 'Return a hierarchical chart of accounts.',
    inputSchema: {},
  }, async function () {
    const data = await repo.getHierarchicalChartOfAccounts();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('account.getByCode', {
    title: 'Get account by code',
    description: 'Lookup an account by numeric code.',
    inputSchema: { code: z.number() },
  }, async function (params) {
    const data = await repo.getAccountByCode(params.code);
    return { content: [{ type: 'text', text: data ? JSON.stringify(data, null, 2) : 'Not found' }] };
  });

  server.registerTool('account.getByName', {
    title: 'Get account by name',
    description: 'Lookup an account by name.',
    inputSchema: { name: z.string() },
  }, async function (params) {
    const data = await repo.getAccountByName(params.name);
    return { content: [{ type: 'text', text: data ? JSON.stringify(data, null, 2) : 'Not found' }] };
  });

  server.registerTool('account.listByTag', {
    title: 'List accounts by tag',
    description: 'Return a paginated list of accounts for a given tag.',
    inputSchema: { tag: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  }, async function (params) {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    const data = await repo.getAccountsByTag(params.tag, offset, limit);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('account.setTag', {
    title: 'Set account tag',
    description: 'Assign a tag to an account.',
    inputSchema: { code: z.number(), tag: z.string() },
  }, async function (params) {
    await repo.setAccountTag(params.code, params.tag);
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('account.unsetTag', {
    title: 'Unset account tag',
    description: 'Remove a tag from an account.',
    inputSchema: { code: z.number(), tag: z.string() },
  }, async function (params) {
    await repo.unsetAccountTag(params.code, params.tag);
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('journal.draft', {
    title: 'Draft journal entry',
    description: 'Create a draft journal entry with lines.',
    inputSchema: {
      entryTime: z.number(),
      description: z.string().nullable().optional(),
      lines: z.array(z.object({ accountCode: z.number(), debit: z.number(), credit: z.number() })),
    },
  }, async function (params) {
    const lines = params.lines as Array<{ accountCode: number; debit: number; credit: number }>;
    const id = await repo.draftJournalEntry({ entryTime: params.entryTime, description: params.description ?? null, lines });
    return { content: [{ type: 'text', text: JSON.stringify({ ref: id }) }] };
  });

  server.registerTool('journal.addLine', {
    title: 'Add journal entry line',
    description: 'Add a line to an existing (draft) journal entry. Uses the auto-numbering view.',
    inputSchema: {
      journalEntryRef: z.number(),
      accountCode: z.number(),
      debit: z.number(),
      credit: z.number(),
      description: z.string().nullable().optional(),
      reference: z.string().nullable().optional(),
    },
  }, async function (params) {
    await repo.sql`
      INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit, description, reference)
      VALUES (${params.journalEntryRef}, ${params.accountCode}, ${params.debit}, ${params.credit}, ${params.description ?? null}, ${params.reference ?? null})
    `;
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('journal.post', {
    title: 'Post journal entry',
    description: 'Set the post_time on a journal entry, causing it to be posted.',
    inputSchema: { ref: z.number(), postTime: z.number() },
  }, async function (params) {
    await repo.postJournalEntry(params.ref, params.postTime);
    return { content: [{ type: 'text', text: 'OK' }] };
  });

  server.registerTool('report.generate', {
    title: 'Generate financial report',
    description: 'Create a balance report snapshot (trial balance & balance sheet) for a given report time.',
    inputSchema: { reportTime: z.number() },
  }, async function (params) {
    const id = await repo.generateFinancialReport(params.reportTime);
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
  });

  server.registerTool('report.trialBalance', {
    title: 'Get trial balance snapshot',
    description: 'Return a trial balance snapshot by report time.',
    inputSchema: { reportTime: z.number() },
  }, async function (params) {
    const data = await repo.getTrialBalanceReport(params.reportTime);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('report.balanceSheet', {
    title: 'Get balance sheet snapshot',
    description: 'Return a balance sheet snapshot by report time.',
    inputSchema: { reportTime: z.number() },
  }, async function (params) {
    const data = await repo.getBalanceSheetReport(params.reportTime);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('sql.query', {
    title: 'Execute SQL query',
    description:
      'Execute a custom SQL query against the accounting database. For best results: MCP clients should first fetch the `sqlite-accounting-schema://schema` resource and include its URI in the `schemaUri` parameter so the LLM has a precise schema reference when generating SQL.',
    inputSchema: {
      sql: z.string(),
      params: z.array(z.unknown()).optional(),
      // Optional URI pointing to the schema resource previously fetched by the client
      schemaUri: z.string().optional(),
    },
  }, async function (params) {
    // If client didn't provide a schemaUri, include a hint in the response so UI/clients know to fetch it
    const warnings: string[] = [];
    if (!params.schemaUri) {
      warnings.push(
        'Warning: For accurate SQL generation, clients should fetch sqlite-accounting-schema://schema and provide its URI as `schemaUri` when calling this tool.'
      );
    }

    const data = await repo.sqlQuery(params.sql, params.params);

    // Build content: optional warnings, query results, and a reference to the schema resource when provided
    const content: any[] = [];
    for (const w of warnings) content.push({ type: 'text', text: w });
    content.push({ type: 'text', text: JSON.stringify(data, null, 2) });
    if (params.schemaUri) {
      // Provide a resource_link so clients / UIs can show the schema as a linked reference
      content.push({
        type: 'resource_link',
        uri: params.schemaUri,
        name: 'sqlite-accounting-schema',
        mimeType: 'text/sql',
        description: 'Database schema used as reference',
      });
    } else {
      // Always include the canonical schema resource link so clients can fetch it if needed
      content.push({
        type: 'resource_link',
        uri: 'sqlite-accounting-schema://schema',
        name: 'sqlite-accounting-schema',
        mimeType: 'text/sql',
        description: 'Canonical database schema (fetch and supply as schemaUri for better LLM results)',
      });
    }

    return { content };
  });

  return server;
}
