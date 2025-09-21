import { AccountingRepository } from '@app/data/accounting-repository.js';
import { formatCurrency, renderAsciiTable } from '@app/formatter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineGetLatestTrialBalanceMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('ViewLatestTrialBalance', {
    title: 'Get latest trial balance report',
    description: 'Fetch the latest trial balance as of a specific date, defaulting to the most recent if no date is provided. Date is in ISO format (yyyy-mm-dd HH:mm).',
    inputSchema: {
      fromDate: z.string().optional(),
    },
  }, async function (params) {
    const userConfig = await repo.getUserConfig();
    const report = await repo.viewLatestTrialBalance(params.fromDate);
    if (!report) {
      return {
        content: [{ type: 'text', text: 'No trial balance reports found. Please create accounts first using ManageManyAccounts, then generate a financial report using GenerateFinancialReport.' }],
      };
    }

    if (report.lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'Trial balance report exists but no accounts were found. Please create accounts first using ManageManyAccounts to populate the trial balance.' }],
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
  server.registerTool('ViewLatestBalanceSheet', {
    title: 'Get latest balance sheet report',
    description: 'Fetch the latest balance sheet as of a specific date, defaulting to the most recent if no date is provided.',
    inputSchema: {
      fromDate: z.string().optional().describe('If provided, fetch the latest balance sheet report as of this date/time. Format is ISO (yyyy-mm-dd HH:mm).'),
    },
  }, async function (params) {
    const formDate = params.fromDate ? new Date(params.fromDate) : null;
    if (params.fromDate && (isNaN(formDate!.getTime()))) {
      return {
        content: [{ type: 'text', text: 'Invalid fromDate format. Please use ISO format (yyyy-mm-dd HH:mm).' }],
      };
    }
    const userConfig = await repo.getUserConfig();
    const report = await repo.viewLatestBalanceSheet(formDate.toISOString());
    if (!report) {
      return {
        content: [{ type: 'text', text: 'No balance sheet reports found. Please create accounts first using ManageManyAccounts, tag them for balance sheet reporting using SetManyAccountTags, then generate a financial report using GenerateFinancialReport.' }],
      };
    }

    if (report.lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'Balance sheet report exists but no balance sheet accounts were found. Please create accounts and tag them for balance sheet reporting using SetManyAccountTags (e.g., "Balance Sheet - Current Asset", "Balance Sheet - Equity").' }],
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
  server.registerTool('GenerateFinancialReport', {
    title: 'Generate financial report',
    description: 'Generate Trial Balance and Balance Sheet snapshots for the current date/time.',
    inputSchema: {},
  }, async function () {
    const reportTime = Date.now();
    const reportId = await repo.GenerateFinancialReport(reportTime);
    return {
      content: [{
        type: 'text',
        text: `Financial report generated with ID ${reportId} at ${new Date(reportTime).toISOString()}. Trial Balance and Balance Sheet snapshots have been created.`,
      }],
    };
  });
}
