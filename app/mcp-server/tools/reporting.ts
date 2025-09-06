import { AccountingRepository } from '@app/data/accounting-repository.js';
import { formatCurrency, renderAsciiTable } from '@app/formatter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineGetLatestTrialBalanceMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('getLatestTrialBalance', {
    title: 'Get latest trial balance',
    description: 'Fetch the latest trial balance as of a specific date, defaulting to the most recent if no date is provided. Date is in ISO format (yyyy-mm-dd HH:mm:ss).',
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
}

export function defineGetLatestBalanceSheetMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('getLatestBalanceSheet', {
    title: 'Get latest balance sheet',
    description: 'Fetch the latest balance sheet as of a specific date, defaulting to the most recent if no date is provided. Date is in ISO format (yyyy-mm-dd HH:mm:ss).',
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
}

export function defineGenerateFinancialReportMCPTool(server: McpServer, repo: AccountingRepository) {
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
}
