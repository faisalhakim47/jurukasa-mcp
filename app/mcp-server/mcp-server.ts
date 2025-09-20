import { AccountingRepository } from '@app/data/accounting-repository.js';
import { defineSqliteAccountingSchemaMCPResource } from '@app/mcp-server/resources/sqlite-accounting-schema.js';
import { defineSetManyAccountTagsMCPTool, defineUnsetManyAccountTagsMCPTool } from '@app/mcp-server/tools/account-tags.js';
import { 
  defineManageManyAccountsMCPTool,
  defineViewChartOfAccountsMCPTool
} from '@app/mcp-server/tools/account-management.js';
import { 
  defineDeleteManyJournalEntryDraftsMCPTool, 
  defineDraftJournalEntryMCPTool, 
  definePostJournalEntryMCPTool, 
  defineReverseJournalEntryMCPTool, 
  defineUpdateJournalEntryMCPTool 
} from '@app/mcp-server/tools/journal-entries.js';
import { 
  defineGenerateFinancialReportMCPTool, 
  defineGetLatestBalanceSheetMCPTool, 
  defineGetLatestTrialBalanceMCPTool 
} from '@app/mcp-server/tools/reporting.js';
import { defineExecuteSqlQueryMCPTool } from '@app/mcp-server/tools/sql-execution.js';
import { defineSetConfigMCPTool, defineGetConfigMCPTool } from '@app/mcp-server/tools/config.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createAccountingMcpServer(repo: AccountingRepository): McpServer {
  const server = new McpServer({
    version: '1.0.0',
    name: 'jurukasa-accounting-mcp',
    title: 'Jurukasa Accounting MCP',
  });

  // Register resources
  defineSqliteAccountingSchemaMCPResource(server);

  // Register account management tools
  defineManageManyAccountsMCPTool(server, repo);
  defineViewChartOfAccountsMCPTool(server, repo);

  // Register account tagging tools
  defineSetManyAccountTagsMCPTool(server, repo);
  defineUnsetManyAccountTagsMCPTool(server, repo);

  // Register journal entry tools
  defineDraftJournalEntryMCPTool(server, repo);
  defineUpdateJournalEntryMCPTool(server, repo);
  definePostJournalEntryMCPTool(server, repo);
  defineDeleteManyJournalEntryDraftsMCPTool(server, repo);
  defineReverseJournalEntryMCPTool(server, repo);

  // Register reporting tools
  defineGetLatestTrialBalanceMCPTool(server, repo);
  defineGetLatestBalanceSheetMCPTool(server, repo);
  defineGenerateFinancialReportMCPTool(server, repo);

  // Register SQL execution tool
  defineExecuteSqlQueryMCPTool(server, repo);

  // Register config tool
  defineSetConfigMCPTool(server, repo);
  defineGetConfigMCPTool(server, repo);

  return server;
}
