import { ok } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/mcp-server/mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertArray, assertPropDefined, assertDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('ReportingMCPTools', function () {
  let repo: SqliteAccountingRepository;
  let client: Client;
  let clientTransport: MemoryTransport;
  let server: McpServer;
  let serverTransport: MemoryTransport;

  beforeEach(async function () {
    repo = new SqliteAccountingRepository(':memory:');
    await repo.connect();
    server = createAccountingMcpServer(repo);
    clientTransport = new MemoryTransport();
    serverTransport = new MemoryTransport();
    clientTransport._paired = serverTransport;
    serverTransport._paired = clientTransport;
    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await repo.setUserConfig({
      businessName: 'Test Business',
      businessType: 'Test',
      currencyCode: 'USD',
      currencyDecimalPlaces: 2,
      locale: 'en-US',
    });

    // Set up initial accounts
    await client.callTool({
      name: 'ManageManyAccounts',
      arguments: {
        accounts: [
          { code: 100, name: 'Cash', normalBalance: 'debit' },
          { code: 200, name: 'Revenue', normalBalance: 'credit' },
          { code: 300, name: 'Equity', normalBalance: 'credit' },
        ],
      },
    });

    // Tag accounts for balance sheet reporting
    await client.callTool({
      name: 'SetManyAccountTags',
      arguments: {
        accountTags: [
          { code: 100, tag: 'Balance Sheet - Current Asset' },
          { code: 300, tag: 'Balance Sheet - Equity' },
        ],
      },
    });

    // Create and post a journal entry to have non-zero balances
    const draftRes = await client.callTool({
      name: 'RecordJournalEntry',
      arguments: {
        date: '2024-01-01',
        description: 'Initial setup entry',
        lines: [
          { accountCode: 100, amount: 1000, type: 'debit' },
          { accountCode: 300, amount: 1000, type: 'credit' },
        ],
      },
    });

    const draftText = (draftRes.content[0] as { text: string }).text;
    const refMatch = draftText.match(/ref (\d+)/);
    assertDefined(refMatch, 'Should extract journal entry reference');
  });

  afterEach(async function () {
    await Promise.all([
      client.close(),
      server.close(),
    ]);
    await repo.close();
  });

  describe('Tool: generateFinancialReport', function () {
    it('generates trial balance and balance sheet snapshots', async function () {
      const res = await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Financial report generated with ID'), 'should confirm report generation');
      ok(responseText.includes('Trial Balance and Balance Sheet snapshots have been created'), 'should mention report types');
      
      // Extract the report ID
      const idMatch = responseText.match(/generated with ID (\d+)/);
      assertDefined(idMatch, 'Should extract report ID');
      const reportId = parseInt(idMatch[1]);
      ok(reportId > 0, 'Should have a valid report ID');
    });

    it('creates separate trial balance and balance sheet reports', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });
      
      // Check that trial balance was created
      const trialBalanceRes = await client.callTool({
        name: 'ViewLatestTrialBalance',
        arguments: {},
      });
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      ok(!trialBalanceText.includes('No trial balance reports found'), 'should have trial balance report');
      
      const balanceSheetRes = await client.callTool({
        name: 'ViewLatestBalanceSheet',
        arguments: {},
      });
      const balanceSheetText = (balanceSheetRes.content[0] as { text: string }).text;
      ok(!balanceSheetText.includes('No balance sheet reports found'), 'should have balance sheet report');
    });
  });

  describe('Tool: ViewLatestTrialBalance', function () {
    beforeEach(async function () {
      // Generate a financial report to have trial balance data
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });
    });

    it('returns the latest trial balance report', async function () {
      const res = await client.callTool({
        name: 'ViewLatestTrialBalance',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Trial Balance Report'), 'should have proper title');
      ok(responseText.includes('Account Code'), 'should have column headers');
      ok(responseText.includes('Account Name'), 'should have column headers');
      ok(responseText.includes('Normal Balance'), 'should have column headers');
      ok(responseText.includes('Debit'), 'should have column headers');
      ok(responseText.includes('Credit'), 'should have column headers');
    });

    it('shows correct balances in trial balance', async function () {
      const res = await client.callTool({
        name: 'ViewLatestTrialBalance',
        arguments: {},
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include Cash account');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should include Equity account');
      // Should show balances from the posted journal entry
      ok(responseText.includes('1000') || responseText.includes('1,000'), 'should show correct amounts');
    });
  });

  describe('Tool: ViewLatestBalanceSheet', function () {
    beforeEach(async function () {
      // Generate a financial report to have balance sheet data
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });
    });

    it('returns the latest balance sheet report', async function () {
      const res = await client.callTool({
        name: 'ViewLatestBalanceSheet',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Balance Sheet Report'), 'should have proper title');
      ok(responseText.includes('Classification'), 'should have column headers');
      ok(responseText.includes('Category'), 'should have column headers');
      ok(responseText.includes('Account Code'), 'should have column headers');
      ok(responseText.includes('Account Name'), 'should have column headers');
      ok(responseText.includes('Amount'), 'should have column headers');
    });

    it('shows only balance sheet accounts', async function () {
      const res = await client.callTool({
        name: 'ViewLatestBalanceSheet',
        arguments: {},
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      // Should only include accounts tagged for balance sheet
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include Cash account');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should include Equity account');
      // Revenue account (200) should not appear as it's not tagged for balance sheet
      ok(!responseText.includes('200'), 'should not include Revenue account');
    });

    it('calculates totals for each classification', async function () {
      const res = await client.callTool({
        name: 'ViewLatestBalanceSheet',
        arguments: {},
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      // Should have total rows
      ok(responseText.includes('TOTAL'), 'should include total calculations');
    });
  });

  describe('Tool: ViewLatestTrialBalance and ViewLatestBalanceSheet - No Reports', function () {
    it('returns no reports when none exist', async function () {
      const trialBalanceRes = await client.callTool({
        name: 'ViewLatestTrialBalance',
        arguments: {},
      });
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      ok(trialBalanceText.includes('No trial balance reports found'), 'should indicate no trial balance reports');
      
      const balanceSheetRes = await client.callTool({
        name: 'ViewLatestBalanceSheet',
        arguments: {},
      });
      const balanceSheetText = (balanceSheetRes.content[0] as { text: string }).text;
      ok(balanceSheetText.includes('No balance sheet reports found'), 'should indicate no balance sheet reports');
    });
  });
});
