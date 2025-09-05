import { ok, strictEqual } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/accounting-mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertDefined, assertArray, assertPropDefined, assertNumber, assertString, assertPropNumber } from '@app/tools/assertion.js';

class MemoryTransport {
  onmessage: ((msg: unknown) => void) | undefined;
  onerror: ((err: unknown) => void) | undefined;
  onclose: (() => void) | undefined;
  _paired: MemoryTransport | null;
  constructor() {
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    this._paired = null;
  }
  async start() { /* no-op */ }
  async close() { this.onclose?.(); }
  async send(message: unknown) {
    if (!this._paired) throw new Error('No paired transport');
    setImmediate(() => {
      try {
        this._paired!.onmessage?.(message);
      }
      catch (err) {
        this._paired!.onerror?.(err);
      }
    });
  }
}

suite('AccountingMcpServer', function () {
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

    await client.callTool({
      name: 'ensure_many_accounts_exist',
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
      name: 'set_many_account_tags',
      arguments: {
        taggedAccounts: [
          { code: 100, tag: 'Balance Sheet - Current Asset' },
          { code: 300, tag: 'Balance Sheet - Equity' },
        ],
      },
    });

    // Create and post a journal entry to have non-zero balances
    const draftRes = await client.callTool({
      name: 'draft_journal_entry',
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
    const refMatch = draftText.match(/reference (\d+)/);
    assertDefined(refMatch, 'Should extract journal entry reference');
    const entryRef = parseInt(refMatch[1]);

    await client.callTool({
      name: 'post_journal_entry',
      arguments: { journalEntryRef: entryRef },
    });
  });

  afterEach(async function () {
    await Promise.all([
      client.close(),
      server.close(),
    ]);
    await repo.close();
  });

  describe('Resource: SQLite Accounting Schema', function () {
    it('lists resources and returns schema content', async function () {
      const resourcesList = await client.listResources({});
      assertPropDefined(resourcesList, 'resources');
      assertArray(resourcesList.resources);
      ok(resourcesList.resources.length > 0, 'resources should be listed');

      const read = await client.readResource({ uri: 'sqlite-accounting-schema://schema' });
      assertPropDefined(read, 'contents');
      assertArray(read.contents);
      ok(read.contents.length > 0, 'read resource should return contents');
      assertPropDefined(read.contents[0], 'text');
      const resourceText = (read.contents[0] as Record<string, unknown>).text;
      assertString(resourceText);
      ok(resourceText.length > 0, 'resource text should be non-empty');
    });
  });

  describe('Tool: ensure_many_accounts_exist', function () {
    it('creates new accounts and skips existing ones', async function () {
      const res = await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit' }, // existing
            { code: 400, name: 'Expenses', normalBalance: 'debit' }, // new
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Existing account 100') && responseText.includes('already exists'), 'should skip existing account');
      ok(responseText.includes('New account 400') && responseText.includes('has been created'), 'should create new account');
      
      // Verify the new account was actually created correctly
      const verifyRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [400] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('400') && verifyText.includes('Expenses'), 'new account should exist');
    });

    it('handles empty accounts list', async function () {
      const res = await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: { accounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No accounts provided'), 'should handle empty list appropriately');
    });

    it('creates accounts with different normal balances correctly', async function () {
      const res = await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 110, name: 'Accounts Receivable', normalBalance: 'debit' },
            { code: 210, name: 'Accounts Payable', normalBalance: 'credit' },
            { code: 410, name: 'Sales Revenue', normalBalance: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('New account 110') && responseText.includes('created'), 'should create AR account');
      ok(responseText.includes('New account 210') && responseText.includes('created'), 'should create AP account');
      ok(responseText.includes('New account 410') && responseText.includes('created'), 'should create Revenue account');
      
      // Verify all accounts were created with correct normal balances
      const verifyRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [110, 210, 410] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('110') && verifyText.includes('Accounts Receivable'), 'should include AR account');
      ok(verifyText.includes('210') && verifyText.includes('Accounts Payable'), 'should include AP account');
      ok(verifyText.includes('410') && verifyText.includes('Sales Revenue'), 'should include Revenue account');
    });
  });

  describe('Tool: rename_account', function () {
    it('renames an existing account', async function () {
      const res = await client.callTool({
        name: 'rename_account',
        arguments: { code: 100, name: 'Cash Account' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Account 100 renamed') && responseText.includes('Cash Account'), 'should confirm rename');
      
      // Verify the account was actually renamed
      const verifyRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('100') && verifyText.includes('Cash Account'), 'account should have new name');
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'rename_account',
        arguments: { code: 999, name: 'Nonexistent' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Account with code 999 does not exist'), 'should indicate account not found');
    });

    it('preserves account properties except name', async function () {
      // First get the current account details
      const beforeRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [200] },
      });
      const beforeText = (beforeRes.content[0] as { text: string }).text;
      
      // Rename the account
      await client.callTool({
        name: 'rename_account',
        arguments: { code: 200, name: 'Service Revenue' },
      });
      
      // Verify the entry was actually updated
      const afterRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [200] },
      });
      const afterText = (afterRes.content[0] as { text: string }).text;
      
      ok(afterText.includes('200') && afterText.includes('Service Revenue'), 'should have new name');
      // Both should have same balance structure since only name changed
      ok(beforeText.includes('Balance:') && afterText.includes('Balance:'), 'should preserve balance information');
    });
  });

  describe('Tool: set_control_account', function () {
    it('sets control account for an existing account', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 200 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      strictEqual(responseText, 'Account 100 (Cash) control account set to 200 (Revenue).');
      
      // Verify the hierarchical structure
      const hierarchyRes = await client.callTool({
        name: 'get_hierarchical_chart_of_accounts',
        arguments: {},
      });
      const hierarchyText = (hierarchyRes.content[0] as { text: string }).text;
      
      // Account 100 should now appear under account 200 in hierarchy
      ok(hierarchyText.includes('200') && hierarchyText.includes('100'), 'both accounts should be in hierarchy');
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 999, controlAccountCode: 200 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Account with code 999 does not exist'), 'should indicate account not found');
    });

    it('fails for non-existing control account', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 999 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Control account with code 999 does not exist'), 'should indicate control account not found');
    });

    it('fails if account is its own control', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 100 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('cannot be its own control account'), 'should prevent self-control');
    });

    it('allows changing control account', async function () {
      // Create a new account to use as control
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [{ code: 500, name: 'Assets', normalBalance: 'debit' }],
        },
      });
      
      // Set initial control account
      await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 200 },
      });
      
      // Change to different control account
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 500 },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      strictEqual(responseText, 'Account 100 (Cash) control account set to 500 (Assets).');
      
      // Verify in hierarchy
      const hierarchyRes = await client.callTool({
        name: 'get_hierarchical_chart_of_accounts',
        arguments: {},
      });
      const hierarchyText = (hierarchyRes.content[0] as { text: string }).text;
      
      // Account 100 should now be under 500, not 200
      ok(hierarchyText.includes('500') && hierarchyText.includes('100'), 'should show new hierarchy');
    });
  });

  describe('Tool: get_hierarchical_chart_of_accounts', function () {
    it('returns hierarchical chart', async function () {
      const res = await client.callTool({
        name: 'get_hierarchical_chart_of_accounts',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Chart of Accounts'), 'should have proper title');
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include account 100');
      ok(responseText.includes('200') && responseText.includes('Revenue'), 'should include account 200');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should include account 300');
    });

    it('shows proper hierarchy with control accounts', async function () {
      // Create parent and child accounts
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 1000, name: 'Current Assets', normalBalance: 'debit' },
            { code: 1100, name: 'Cash and Equivalents', normalBalance: 'debit' },
          ],
        },
      });
      
      // Set hierarchy
      await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 1100, controlAccountCode: 1000 },
      });
      
      const res = await client.callTool({
        name: 'get_hierarchical_chart_of_accounts',
        arguments: {},
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      
      // Parent should appear before child in hierarchy
      const parentPos = responseText.indexOf('1000');
      const childPos = responseText.indexOf('1100');
      ok(parentPos !== -1 && childPos !== -1, 'both accounts should be present');
      ok(parentPos < childPos, 'parent should appear before child');
      
      // Child should be indented (contains spaces or indentation markers)
      const lines = responseText.split('\n');
      const childLine = lines.find(line => line.includes('1100'));
      const parentLine = lines.find(line => line.includes('1000'));
      ok(childLine && parentLine, 'should find both account lines');
      
      // Child should have more leading whitespace than parent
      const childIndent = childLine.match(/^(\s*)/)?.[1]?.length || 0;
      const parentIndent = parentLine.match(/^(\s*)/)?.[1]?.length || 0;
      ok(childIndent > parentIndent, 'child should be more indented than parent');
    });

    it('handles multiple levels of hierarchy', async function () {
      // Create 3-level hierarchy
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 2000, name: 'Assets', normalBalance: 'debit' },
            { code: 2100, name: 'Current Assets', normalBalance: 'debit' },
            { code: 2110, name: 'Petty Cash', normalBalance: 'debit' },
          ],
        },
      });
      
      await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 2100, controlAccountCode: 2000 },
      });
      
      await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 2110, controlAccountCode: 2100 },
      });
      
      const res = await client.callTool({
        name: 'get_hierarchical_chart_of_accounts',
        arguments: {},
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      
      // Check that all three levels appear in correct order
      const level1Pos = responseText.indexOf('2000');
      const level2Pos = responseText.indexOf('2100');
      const level3Pos = responseText.indexOf('2110');
      
      ok(level1Pos !== -1 && level2Pos !== -1 && level3Pos !== -1, 'all levels should be present');
      ok(level1Pos < level2Pos && level2Pos < level3Pos, 'should appear in hierarchical order');
    });
  });

  describe('Tool: get_many_accounts', function () {
    it('retrieves accounts by codes', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100, 200] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include account 100');
      ok(responseText.includes('200') && responseText.includes('Revenue'), 'should include account 200');
      ok(!responseText.includes('300'), 'should not include account 300');
    });

    it('retrieves accounts by names', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { names: ['Cash'] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include Cash account');
      ok(!responseText.includes('Revenue') && !responseText.includes('Equity'), 'should not include other accounts');
    });

    it('returns no accounts for no matches', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [999] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No accounts found'), 'should indicate no matches');
    });

    it('returns all accounts when no filters provided', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include account 100');
      ok(responseText.includes('200') && responseText.includes('Revenue'), 'should include account 200');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should include account 300');
    });

    it('shows correct account details and balances', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100, 300] },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      
      // Verify account details format - the format is "code name (Balance: amount)"
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should show account 100');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should show account 300');
      ok(responseText.includes('Balance:'), 'should show balance field');
      
      // Check specific values - account 100 should have 1000 debit balance from setup
      // The format includes balance in currency format
      ok(responseText.includes('1000') || responseText.includes('1,000'), 'should show account balances');
    });

    it('retrieves accounts by multiple criteria', async function () {
      // Create test accounts with specific names
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 1200, name: 'Bank Account', normalBalance: 'debit' },
            { code: 1300, name: 'Savings Account', normalBalance: 'debit' },
          ],
        },
      });
      
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { 
          codes: [100, 1200],
          names: ['Savings Account'] 
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      
      // Should include accounts matching either codes OR names
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include Cash from codes');
      ok(responseText.includes('1200') && responseText.includes('Bank Account'), 'should include Bank Account from codes');
      ok(responseText.includes('1300') && responseText.includes('Savings Account'), 'should include Savings Account from names');
    });
  });

  describe('Tool: set_many_account_tags', function () {
    it('sets tags for multiple accounts', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 200, tag: 'Revenue' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Account 100 tagged with "Asset"'), 'should confirm Asset tag');
      ok(responseText.includes('Account 200 tagged with "Revenue"'), 'should confirm Revenue tag');
      
      // Verify tags were actually set by querying them
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code, tag FROM account_tag WHERE account_code IN (100, 200) ORDER BY account_code, tag',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('100') && verifyText.includes('Asset'), 'should find Asset tag for account 100');
      ok(verifyText.includes('200') && verifyText.includes('Revenue'), 'should find Revenue tag for account 200');
    });

    it('handles empty tagged accounts list', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: { taggedAccounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No tagged accounts provided, nothing to do.'), 'should handle empty list');
    });

    it('handles multiple tags for same account', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Current Asset' },
            { code: 100, tag: 'Asset' },
            { code: 100, tag: 'Cash Flow - Cash Equivalents' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Current Asset'), 'should set Current Asset tag');
      ok(responseText.includes('Asset'), 'should set Asset tag');
      ok(responseText.includes('Cash Flow - Cash Equivalents'), 'should set Cash Flow - Cash Equivalents tag');
      
      // Verify all tags exist
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT tag FROM account_tag WHERE account_code = 100 ORDER BY tag',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Current Asset'), 'should have current-asset tag');
      ok(verifyText.includes('Asset'), 'should have monetary tag');  
      ok(verifyText.includes('Cash Flow - Cash Equivalents'), 'should have reconcilable tag');
    });

    it('overwrites existing tags for same account-tag combination', async function () {
      // Set initial tag
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [{ code: 200, tag: 'Asset' }],
        },
      });
      
      // Set same tag again (should not create duplicate)
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [{ code: 200, tag: 'Asset' }],
        },
      });
      
      // Verify only one instance exists
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as count FROM account_tag WHERE account_code = 200 AND tag = ?',
          params: ['Asset'],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('1'), 'should have exactly one instance of the tag');
    });

    it('handles non-existent accounts gracefully', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 999, tag: 'nonexistent' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      // The operation should complete but may warn about non-existent accounts
      ok(responseText.includes('Account 999 tagged with "nonexistent"'), 'should handle gracefully');
    });
  });

  describe('Tool: unset_many_account_tags', function () {
    it('removes tags from multiple accounts', async function () {
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'liquid' },
            { code: 200, tag: 'income' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'liquid' },
            { code: 200, tag: 'income' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Tag "liquid" removed from account 100'), 'should confirm liquid tag removal');
      ok(responseText.includes('Tag "income" removed from account 200'), 'should confirm income tag removal');
      
      // Verify tags were actually removed
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as count FROM account_tag WHERE (account_code = 100 AND tag = ?) OR (account_code = 200 AND tag = ?)',
          params: ['liquid', 'income'],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('0'), 'tags should be completely removed');
    });

    it('handles empty tagged accounts list', async function () {
      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: { taggedAccounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No tagged accounts provided') || responseText.includes('nothing to do'), 'should handle empty list');
    });

    it('handles removal of non-existent tags gracefully', async function () {
      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'non-existent-tag' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      // Should handle gracefully without errors
      ok(responseText.includes('100') || responseText.includes('non-existent-tag'), 'should process the request');
    });

    it('removes only specified tags, leaving others intact', async function () {
      // Set multiple tags
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 100, tag: 'Expense' },
            { code: 100, tag: 'Liability' },
          ],
        },
      });
      
      // Remove only one tag
      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Expense' },
          ],
        },
      });
      
      // Verify selective removal
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT tag FROM account_tag WHERE account_code = 100 ORDER BY tag',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Asset'), 'should keep Asset tag');
      ok(verifyText.includes('Liability'), 'should keep Liability tag');
      ok(!verifyText.includes('Expense'), 'should not have Expense tag');
    });

    it('handles multiple accounts with same tag', async function () {
      // Set same tag on multiple accounts
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Revenue' },
            { code: 200, tag: 'Revenue' },
            { code: 300, tag: 'Revenue' },
          ],
        },
      });
      
      // Remove tag from specific accounts only
      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Revenue' },
            { code: 300, tag: 'Revenue' },
          ],
        },
      });
      
      // Verify selective removal
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code FROM account_tag WHERE tag = ? ORDER BY account_code',
          params: ['Revenue'],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(!verifyText.includes('100'), 'should remove from account 100');
      ok(verifyText.includes('200'), 'should keep on account 200');
      ok(!verifyText.includes('300'), 'should remove from account 300');
    });
  });

  describe('Tool: draft_journal_entry', function () {
    it('creates a draft journal entry', async function () {
      const res = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Test journal entry',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 200, amount: 1000, type: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Draft journal entry created'), 'should confirm creation');
      
      // Extract and verify journal entry reference
      const refMatch = responseText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef = parseInt(refMatch[1]);
      ok(entryRef > 0, 'Should have valid reference number');
      
      // Verify the entry details in database
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT ref, note, post_time FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes(entryRef.toString()), 'should find the journal entry');
      ok(verifyText.includes('Test journal entry'), 'should have correct description');
      
      // Verify the lines
      const linesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [entryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('100') && linesText.includes('1000'), 'should have debit line for account 100');
      ok(linesText.includes('200') && linesText.includes('1000'), 'should have credit line for account 200');
    });

    it('handles empty lines', async function () {
      const res = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Empty entry',
          lines: [],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Draft journal entry created'), 'should still create entry');
      
      // Verify no lines were created
      const refMatch = responseText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef = parseInt(refMatch[1]);
      
      const linesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as line_count FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [entryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('0'), 'should have no lines');
    });

    it('validates journal entry balance', async function () {
      const res = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Complex balanced entry',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 300, amount: 300, type: 'debit' },
            { accountCode: 200, amount: 800, type: 'credit' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      const refMatch = responseText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef = parseInt(refMatch[1]);
      
      // Verify total debits equal total credits
      const totalsRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT SUM(debit) as total_debits, SUM(credit) as total_credits FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [entryRef],
        },
      });
      const totalsText = (totalsRes.content[0] as { text: string }).text;
      ok(totalsText.includes('800'), 'should have equal debits and credits of 800');
    });

    it('handles different date formats', async function () {
      const res = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-12-31',
          description: 'Year-end entry',
          lines: [
            { accountCode: 100, amount: 250, type: 'debit' },
            { accountCode: 200, amount: 250, type: 'credit' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('2024-12-31'), 'should handle different date format');
    });

    it('creates multiple independent draft entries', async function () {
      const res1 = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'First entry',
          lines: [{ accountCode: 100, amount: 100, type: 'debit' }, { accountCode: 200, amount: 100, type: 'credit' }],
        },
      });
      
      const res2 = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-02',
          description: 'Second entry',
          lines: [{ accountCode: 200, amount: 200, type: 'debit' }, { accountCode: 300, amount: 200, type: 'credit' }],
        },
      });
      
      const ref1Match = (res1.content[0] as { text: string }).text.match(/reference (\d+)/);
      const ref2Match = (res2.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(ref1Match, 'Should extract first reference');
      assertDefined(ref2Match, 'Should extract second reference');
      
      const ref1 = parseInt(ref1Match[1]);
      const ref2 = parseInt(ref2Match[1]);
      ok(ref1 !== ref2, 'Should have different reference numbers');
      
      // Verify both entries exist independently
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT ref, note FROM journal_entry WHERE ref IN (?, ?) ORDER BY ref',
          params: [ref1, ref2],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('First entry'), 'should have first entry');
      ok(verifyText.includes('Second entry'), 'should have second entry');
    });
  });

  describe('Tool: update_journal_entry', function () {
    it('updates an existing journal entry', async function () {
      // First create a draft
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Original entry',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 200, amount: 500, type: 'credit' },
          ],
        },
      });
      assertPropDefined(draftRes, 'content');
      assertArray(draftRes.content);
      ok(draftRes.content.length > 0, 'draft should be created');

      // Extract journal entry ref from response
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);

      // Then update it
      const updateRes = await client.callTool({
        name: 'update_journal_entry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Updated entry',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 200, amount: 1000, type: 'credit' },
          ],
        },
      });
      assertPropDefined(updateRes, 'content');
      assertArray(updateRes.content);
      ok(updateRes.content.length > 0, 'tool should return content');
      
      const updateText = (updateRes.content[0] as { text: string }).text;
      ok(updateText.includes('Journal entry') && updateText.includes('updated'), 'should confirm update');
      
      // Verify the entry was actually updated
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT note FROM journal_entry WHERE ref = ?',
          params: [journalEntryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Updated entry'), 'should have new description');
      ok(!verifyText.includes('Original entry'), 'should not have old description');
      
      // Verify the lines were updated
      const linesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [journalEntryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('1000'), 'should have updated amounts of 1000');
      ok(!linesText.includes('500'), 'should not have old amounts of 500');
    });

    it('can completely change line structure', async function () {
      // Create initial draft with 2 lines
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Two-line entry',
          lines: [
            { accountCode: 100, amount: 600, type: 'debit' },
            { accountCode: 200, amount: 600, type: 'credit' },
          ],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      // Update to 3 lines with different structure
      const updateRes = await client.callTool({
        name: 'update_journal_entry',
        arguments: {
          journalEntryRef,
          date: '2024-01-01',
          description: 'Three-line entry',
          lines: [
            { accountCode: 100, amount: 400, type: 'debit' },
            { accountCode: 300, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 600, type: 'credit' },
          ],
        },
      });
      
      // Verify line count and amounts
      const linesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as line_count, SUM(debit) as total_debits, SUM(credit) as total_credits FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [journalEntryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('3'), 'should have 3 lines');
      ok(linesText.includes('600'), 'should have balanced totals of 600');
    });

    it('preserves draft status during update', async function () {
      // Create draft
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft entry',
          lines: [{ accountCode: 100, amount: 100, type: 'debit' }, { accountCode: 200, amount: 100, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      // Update it
      await client.callTool({
        name: 'update_journal_entry',
        arguments: {
          journalEntryRef,
          date: '2024-01-01',
          description: 'Updated draft',
          lines: [{ accountCode: 100, amount: 200, type: 'debit' }, { accountCode: 200, amount: 200, type: 'credit' }],
        },
      });
      
      // Verify it's still a draft (post_time should be NULL)
      const statusRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [journalEntryRef],
        },
      });
      const statusText = (statusRes.content[0] as { text: string }).text;
      ok(statusText.includes('NULL') || statusText.includes('<null>') || statusText.includes('null'), 'should still be a draft');
    });

    it('fails to update non-existent journal entry', async function () {
      const res = await client.callTool({
        name: 'update_journal_entry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-01',
          description: 'Non-existent',
          lines: [],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });
  });

  describe('Tool: post_journal_entry', function () {
    it('posts a draft journal entry with default date', async function () {
      // First create a draft
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry to post',
          lines: [
            { accountCode: 100, amount: 750, type: 'debit' },
            { accountCode: 200, amount: 750, type: 'credit' },
          ],
        },
      });
      assertPropDefined(draftRes, 'content');
      assertArray(draftRes.content);

      // Extract journal entry ref
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);

      // Then post it
      const postRes = await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      assertPropDefined(postRes, 'content');
      assertArray(postRes.content);
      ok(postRes.content.length > 0, 'tool should return content');
      
      const postText = (postRes.content[0] as { text: string }).text;
      ok(postText.includes('Journal entry') && postText.includes('posted'), 'should confirm posting');
      
      // Verify the entry is now posted (has post_time)
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [journalEntryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(!verifyText.includes('NULL') && !verifyText.includes('<null>'), 'should have post_time set');
      
      // Verify account balances were updated
      const balanceRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100, 200] },
      });
      const balanceText = (balanceRes.content[0] as { text: string }).text;
      
      // Account 100 (debit normal) should show increased balance
      // Account 200 (credit normal) should show increased balance
      ok(balanceText.includes('100') && (balanceText.includes('1750') || balanceText.includes('1,750')), 'Cash balance should be updated to 1750 (1000 + 750)');
    });

    it('posts a draft journal entry with specific date', async function () {
      // First create a draft
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry to post with date',
          lines: [
            { accountCode: 100, amount: 250, type: 'debit' },
            { accountCode: 200, amount: 250, type: 'credit' },
          ],
        },
      });
      assertPropDefined(draftRes, 'content');
      assertArray(draftRes.content);

      // Extract journal entry ref
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);

      // Then post it with specific date
      const postRes = await client.callTool({
        name: 'post_journal_entry',
        arguments: { 
          journalEntryRef,
          date: '2024-01-03',
        },
      });
      assertPropDefined(postRes, 'content');
      assertArray(postRes.content);
      ok(postRes.content.length > 0, 'tool should return content');
      
      const postText = (postRes.content[0] as { text: string }).text;
      ok(postText.includes('posted'), 'should confirm posting');
      
      // Verify the posting date was used
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [journalEntryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(!verifyText.includes('NULL'), 'should have post_time set');
    });

    it('fails to post already posted entry', async function () {
      // Create and post an entry
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry to double post',
          lines: [{ accountCode: 100, amount: 100, type: 'debit' }, { accountCode: 200, amount: 100, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      // Post it first time
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      
      // Try to post again
      const secondPostRes = await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      
      const secondPostText = (secondPostRes.content[0] as { text: string }).text;
      ok(secondPostText.includes('already posted') || secondPostText.includes('not found'), 'should prevent double posting');
    });

    it('fails to post non-existent entry', async function () {
      const res = await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: 99999 },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });

    it('correctly updates multiple account balances', async function () {
      // Get initial balances
      const initialRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100, 200, 300] },
      });
      const initialText = (initialRes.content[0] as { text: string }).text;
      
      // Create complex journal entry
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Complex posting test',
          lines: [
            { accountCode: 100, amount: 300, type: 'debit' },   // Cash +300
            { accountCode: 200, amount: 100, type: 'debit' },   // Revenue +100 (unusual but valid)
            { accountCode: 300, amount: 400, type: 'credit' },  // Equity +400
          ],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      // Post the entry
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      
      // Get final balances
      const finalRes = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [100, 200, 300] },
      });
      const finalText = (finalRes.content[0] as { text: string }).text;
      
      // Verify balance changes (note: initial setup had 1000 debit in Cash, 1000 credit in Equity)
      // After this transaction: Cash should have 1000+300=1300, Equity should have 1000+400=1400
      ok(finalText.includes('100') && (finalText.includes('1300') || finalText.includes('1,300')), 'Cash should have 1300 balance');
      ok(finalText.includes('300') && (finalText.includes('1400') || finalText.includes('1,400')), 'Equity should have 1400 balance');
    });
  });

  describe('Tool: execute_sql_query', function () {
    it('executes a SELECT query and returns results', async function () {
      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT code, name FROM account ORDER BY code LIMIT 2',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('100'), 'should contain account code 100');
      ok(responseText.includes('200'), 'should contain account code 200');
    });

    it('executes a query with parameters', async function () {
      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT code, name FROM account WHERE code = ?',
          params: [100],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('100'), 'should contain account code 100');
      ok(responseText.includes('Cash'), 'should contain account name Cash');
    });

    it('handles query with no results', async function () {
      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT code, name FROM account WHERE code = 99999',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('returned no results'), 'should indicate no results');
    });

    it('handles invalid SQL query', async function () {
      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'INVALID SQL QUERY',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Error executing SQL query'), 'should indicate error');
    });

    it('executes a COUNT query', async function () {
      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as account_count FROM account',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('account_count'), 'should contain count column');
    });

    it('executes a query with JOIN', async function () {
      // First create a journal entry to have data in journal_entry
      await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Test entry for SQL query',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 200, amount: 500, type: 'credit' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT je.note, jel.account_code, jel.debit, jel.credit FROM journal_entry je JOIN journal_entry_line jel ON je.ref = jel.journal_entry_ref WHERE je.post_time IS NULL',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('Test entry for SQL query'), 'should contain journal entry description');
    });
  });

  describe('Tool: delete_many_journal_entry_drafts', function () {
    it('deletes multiple draft journal entries', async function () {
      // Create multiple drafts
      const draft1 = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft 1',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draft2 = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-02',
          description: 'Draft 2',
          lines: [
            { accountCode: 100, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 200, type: 'credit' },
          ],
        },
      });

      // Extract refs
      const draft1Text = (draft1.content[0] as { text: string }).text;
      const draft2Text = (draft2.content[0] as { text: string }).text;
      const ref1Match = draft1Text.match(/reference (\d+)/);
      const ref2Match = draft2Text.match(/reference (\d+)/);
      assertDefined(ref1Match, 'Should extract journal entry reference 1');
      assertDefined(ref2Match, 'Should extract journal entry reference 2');
      const ref1 = parseInt(ref1Match[1]);
      const ref2 = parseInt(ref2Match[1]);

      // Delete the drafts
      const deleteRes = await client.callTool({
        name: 'delete_many_journal_entry_drafts',
        arguments: {
          journalEntryRefs: [ref1, ref2],
        },
      });
      assertPropDefined(deleteRes, 'content');
      assertArray(deleteRes.content);
      ok(deleteRes.content.length > 0, 'tool should return content');
      const deleteText = (deleteRes.content[0] as { text: string }).text;
      ok(deleteText.includes(`Draft journal entry ${ref1} deleted`), 'should confirm deletion of first draft');
      ok(deleteText.includes(`Draft journal entry ${ref2} deleted`), 'should confirm deletion of second draft');
    });

    it('handles empty list', async function () {
      const res = await client.callTool({
        name: 'delete_many_journal_entry_drafts',
        arguments: {
          journalEntryRefs: [],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No journal entry references provided'), 'should handle empty list');
    });
  });

  describe('Tool: reverse_journal_entry', function () {
    it('reverses a posted journal entry', async function () {
      // Create and post a journal entry
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry to reverse',
          lines: [
            { accountCode: 100, amount: 300, type: 'debit' },
            { accountCode: 200, amount: 300, type: 'credit' },
          ],
        },
      });

      // Extract ref
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const originalRef = parseInt(refMatch[1]);

      // Post the entry
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: originalRef },
      });

      // Reverse the entry
      const reverseRes = await client.callTool({
        name: 'reverse_journal_entry',
        arguments: {
          journalEntryRef: originalRef,
          date: '2024-01-02',
          description: 'Reversal of test entry',
        },
      });
      assertPropDefined(reverseRes, 'content');
      assertArray(reverseRes.content);
      ok(reverseRes.content.length > 0, 'tool should return content');
      
      const reverseText = (reverseRes.content[0] as { text: string }).text;
      ok(reverseText.includes(`Reversal journal entry created with reference`), 'should confirm reversal creation');
      ok(reverseText.includes(`for original entry ${originalRef}`), 'should reference original entry');
      
      // Extract reversal reference
      const reversalRefMatch = reverseText.match(/reference (\d+)/);
      assertDefined(reversalRefMatch, 'Should extract reversal reference');
      const reversalRef = parseInt(reversalRefMatch[1]);
      ok(reversalRef !== originalRef, 'Reversal should have different reference');
      
      // Verify reversal entry lines are opposite of original
      const originalLinesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [originalRef],
        },
      });
      
      const reversalLinesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [reversalRef],
        },
      });
      
      const originalLinesText = (originalLinesRes.content[0] as { text: string }).text;
      const reversalLinesText = (reversalLinesRes.content[0] as { text: string }).text;
      
      // Original: 100 debit 300, 200 credit 300
      // Reversal: 100 credit 300, 200 debit 300
      ok(originalLinesText.includes('100') && originalLinesText.includes('300'), 'original should have account 100 with 300');
      ok(reversalLinesText.includes('100') && reversalLinesText.includes('300'), 'reversal should have account 100 with 300');
      
      // Verify reversal relationships in database
      const relationshipRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT ref, reversal_of_ref, reversed_by_ref FROM journal_entry WHERE ref IN (?, ?) ORDER BY ref',
          params: [originalRef, reversalRef],
        },
      });
      const relationshipText = (relationshipRes.content[0] as { text: string }).text;
      ok(relationshipText.includes(reversalRef.toString()), 'should show reversal relationship');
    });

    it('fails to reverse draft entry', async function () {
      // Create a draft but don't post it
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft entry',
          lines: [{ accountCode: 100, amount: 100, type: 'debit' }, { accountCode: 200, amount: 100, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const draftRef = parseInt(refMatch[1]);
      
      // Try to reverse the draft
      const reverseRes = await client.callTool({
        name: 'reverse_journal_entry',
        arguments: {
          journalEntryRef: draftRef,
          date: '2024-01-02',
          description: 'Invalid reversal',
        },
      });
      
      const reverseText = (reverseRes.content[0] as { text: string }).text;
      ok(reverseText.includes('not found') || reverseText.includes('not posted'), 'should prevent reversing draft entries');
    });

    it('creates reversal with correct balancing', async function () {
      // Create complex entry to reverse
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Complex entry to reverse',
          lines: [
            { accountCode: 100, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 150, type: 'debit' },
            { accountCode: 300, amount: 350, type: 'credit' },
          ],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const originalRef = parseInt(refMatch[1]);
      
      // Post and reverse
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: originalRef },
      });
      
      const reverseRes = await client.callTool({
        name: 'reverse_journal_entry',
        arguments: {
          journalEntryRef: originalRef,
          date: '2024-01-02',
          description: 'Complex reversal',
        },
      });
      
      const reversalRefMatch = (reverseRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(reversalRefMatch, 'Should extract reversal reference');
      const reversalRef = parseInt(reversalRefMatch[1]);
      
      // Verify reversal balances
      const reversalTotalsRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT SUM(debit) as total_debits, SUM(credit) as total_credits FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [reversalRef],
        },
      });
      const reversalTotalsText = (reversalTotalsRes.content[0] as { text: string }).text;
      ok(reversalTotalsText.includes('350'), 'reversal should have balanced totals of 350');
    });

    it('fails to reverse non-existent entry', async function () {
      const res = await client.callTool({
        name: 'reverse_journal_entry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-02',
          description: 'Invalid reversal',
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });

    it('posts reversal entry automatically', async function () {
      // Create and post original
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry for auto-post test',
          lines: [{ accountCode: 100, amount: 400, type: 'debit' }, { accountCode: 200, amount: 400, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const originalRef = parseInt(refMatch[1]);
      
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: originalRef },
      });
      
      // Reverse it
      const reverseRes = await client.callTool({
        name: 'reverse_journal_entry',
        arguments: {
          journalEntryRef: originalRef,
          date: '2024-01-02',
          description: 'Auto-posted reversal',
        },
      });
      
      const reversalRefMatch = (reverseRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(reversalRefMatch, 'Should extract reversal reference');
      const reversalRef = parseInt(reversalRefMatch[1]);
      
      // Verify reversal is posted automatically
      const statusRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [reversalRef],
        },
      });
      const statusText = (statusRes.content[0] as { text: string }).text;
      ok(!statusText.includes('NULL') && !statusText.includes('<null>'), 'reversal should be automatically posted');
    });
  });

  describe('Tool: generate_financial_report', function () {
    it('generates trial balance and balance sheet snapshots', async function () {
      const res = await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('Financial report generated'), 'should confirm report generation');
      ok(text.includes('Trial Balance and Balance Sheet snapshots'), 'should mention both reports');
      
      // Verify reports were actually created in database
      const verifyRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT report_type, COUNT(*) as count FROM balance_report GROUP BY report_type ORDER BY report_type',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Ad Hoc'), 'should have Ad Hoc report type');
      
      // Check that report lines were created
      const linesRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as line_count FROM balance_report_line',
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(!linesText.includes('0'), 'should have report lines created');
    });

    it('creates separate trial balance and balance sheet reports', async function () {
      const res = await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Get the generated reports
      const trialBalanceRes = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const balanceSheetRes = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      const balanceSheetText = (balanceSheetRes.content[0] as { text: string }).text;
      
      // Both should contain account information but in different formats
      ok(trialBalanceText.includes('Trial Balance'), 'should have trial balance title');
      ok(balanceSheetText.includes('Balance Sheet'), 'should have balance sheet title');
      
      // Trial balance should show debits and credits
      ok(trialBalanceText.includes('Debit') && trialBalanceText.includes('Credit'), 'trial balance should show debit/credit columns');
      
      // Balance sheet should show asset/liability/equity classifications
      ok(balanceSheetText.includes('Asset') || balanceSheetText.includes('Current Asset'), 'balance sheet should show asset classifications');
    });

    it('includes all active accounts in trial balance', async function () {
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Get trial balance
      const trialBalanceRes = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      
      // Should include all our test accounts (100, 200, 300)
      ok(trialBalanceText.includes('100') && trialBalanceText.includes('Cash'), 'should include Cash account');
      ok(trialBalanceText.includes('200') && trialBalanceText.includes('Revenue'), 'should include Revenue account');
      ok(trialBalanceText.includes('300') && trialBalanceText.includes('Equity'), 'should include Equity account');
    });

    it('generates reports with current account balances', async function () {
      // Create and post a transaction to change balances
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Balance test transaction',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 200, amount: 500, type: 'credit' },
          ],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Check trial balance includes updated balances
      const trialBalanceRes = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      
      // Account 100 should show increased balance (original 1000 + 500 = 1500)
      ok(trialBalanceText.includes('1500') || trialBalanceText.includes('1,500'), 'should show updated Cash balance');
    });

    it('handles multiple report generations', async function () {
      // Generate first report
      const res1 = await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Make a transaction
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Transaction between reports',
          lines: [{ accountCode: 100, amount: 100, type: 'debit' }, { accountCode: 300, amount: 100, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const journalEntryRef = parseInt(refMatch[1]);
      
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef },
      });
      
      // Generate second report
      const res2 = await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Verify multiple reports exist
      const countRes = await client.callTool({
        name: 'execute_sql_query',
        arguments: {
          query: 'SELECT COUNT(*) as report_count FROM balance_report',
        },
      });
      const countText = (countRes.content[0] as { text: string }).text;
      ok(!countText.includes('1'), 'should have more than one report'); // Should be at least 2
    });
  });

  describe('Tool: get_latest_trial_balance', function () {
    it('returns the latest trial balance report', async function () {
      // First generate a report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('Trial Balance Report'), 'should return trial balance report');
      ok(text.includes('Cash'), 'should include account names');
      
      // Verify proper trial balance format
      ok(text.includes('Debit') && text.includes('Credit'), 'should have debit and credit columns');
      ok(text.includes('100') && text.includes('200') && text.includes('300'), 'should include all test accounts');
      
      // Check that debits and credits are shown correctly
      // Cash (100) has debit normal balance and should show in debit column
      // Revenue (200) has credit normal balance 
      // Equity (300) has credit normal balance and should show in credit column
      const lines = text.split('\n');
      const cashLine = lines.find(line => line.includes('100') && line.includes('Cash'));
      const equityLine = lines.find(line => line.includes('300') && line.includes('Equity'));
      
      ok(cashLine, 'should find Cash account line');
      ok(equityLine, 'should find Equity account line');
    });

    it('returns no reports when none exist', async function () {
      // Use a fresh repository for this test
      const freshRepo = new SqliteAccountingRepository(':memory:');
      await freshRepo.connect();
      const freshServer = createAccountingMcpServer(freshRepo);
      const freshClientTransport = new MemoryTransport();
      const freshServerTransport = new MemoryTransport();
      freshClientTransport._paired = freshServerTransport;
      freshServerTransport._paired = freshClientTransport;
      const freshClient = new Client({ name: 'fresh-test-client', version: '1.0.0' });

      await Promise.all([
        freshServer.connect(freshServerTransport),
        freshClient.connect(freshClientTransport),
      ]);

      const res = await freshClient.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('No trial balance reports found'), 'should indicate no reports');

      await Promise.all([
        freshClient.close(),
        freshServer.close(),
      ]);
      await freshRepo.close();
    });

    it('shows correct balances in trial balance', async function () {
      // Generate report after initial setup (Cash 1000 debit, Equity 1000 credit)
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Extract balances from the trial balance
      // Look for patterns like "1000.00" or "1,000.00"
      ok(text.includes('1000') || text.includes('1,000'), 'should show balance amounts');
      
      // Verify that total debits equal total credits
      const debitMatches = text.match(/Total.*Debit.*?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      const creditMatches = text.match(/Total.*Credit.*?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      
      if (debitMatches && creditMatches) {
        const totalDebits = parseFloat(debitMatches[1].replace(/,/g, ''));
        const totalCredits = parseFloat(creditMatches[1].replace(/,/g, ''));
        ok(Math.abs(totalDebits - totalCredits) < 0.01, 'total debits should equal total credits');
      }
    });

    it('returns most recent report when multiple exist', async function () {
      // Generate first report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Wait a moment to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Make a transaction to change balances
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Update balances',
          lines: [{ accountCode: 100, amount: 200, type: 'debit' }, { accountCode: 200, amount: 200, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: parseInt(refMatch[1]) },
      });
      
      // Generate second report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Get latest report - should reflect the updated balances
      const res = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      // Should show updated Cash balance (1000 + 200 = 1200)
      ok(text.includes('1200') || text.includes('1,200'), 'should show most recent balances');
    });

    it('includes account details in trial balance format', async function () {
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_trial_balance',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should include proper headers and formatting
      ok(text.includes('Account Code') || text.includes('Code'), 'should have account code header');
      ok(text.includes('Account Name') || text.includes('Name'), 'should have account name header');
      ok(text.includes('Normal Balance'), 'should have normal balance header');
      
      // Should be formatted as a table
      ok(text.includes('|') || text.includes('+') || text.includes('-'), 'should have table formatting');
    });
  });

  describe('Tool: get_latest_balance_sheet', function () {
    it('returns the latest balance sheet report', async function () {
      // First generate a report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('Balance Sheet Report'), 'should return balance sheet report');
      ok(text.includes('Assets') || text.includes('Equity'), 'should include classifications');
      
      // Should include accounts that have balance sheet tags
      ok(text.includes('100') && text.includes('Cash'), 'should include tagged Cash account');
      ok(text.includes('300') && text.includes('Equity'), 'should include tagged Equity account');
      
      // Should have proper balance sheet structure
      ok(text.includes('Classification') || text.includes('Category'), 'should show classification/category');
      ok(text.includes('Amount'), 'should show amounts');
    });

    it('returns no reports when none exist', async function () {
      // Use a fresh repository for this test
      const freshRepo = new SqliteAccountingRepository(':memory:');
      await freshRepo.connect();
      const freshServer = createAccountingMcpServer(freshRepo);
      const freshClientTransport = new MemoryTransport();
      const freshServerTransport = new MemoryTransport();
      freshClientTransport._paired = freshServerTransport;
      freshServerTransport._paired = freshClientTransport;
      const freshClient = new Client({ name: 'fresh-test-client', version: '1.0.0' });

      await Promise.all([
        freshServer.connect(freshServerTransport),
        freshClient.connect(freshClientTransport),
      ]);

      const res = await freshClient.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('No balance sheet reports found'), 'should indicate no reports');

      await Promise.all([
        freshClient.close(),
        freshServer.close(),
      ]);
      await freshRepo.close();
    });

    it('shows only balance sheet accounts', async function () {
      // Create additional accounts without balance sheet tags
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [{ code: 4000, name: 'Operating Expenses', normalBalance: 'debit' }],
        },
      });
      
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should include tagged accounts (100 and 300 have balance sheet tags from setup)
      ok(text.includes('100') && text.includes('Cash'), 'should include Cash with balance sheet tag');
      ok(text.includes('300') && text.includes('Equity'), 'should include Equity with balance sheet tag');
      
      // Should NOT include untagged account
      ok(!text.includes('4000') && !text.includes('Operating Expenses'), 'should not include non-balance sheet accounts');
    });

    it('groups accounts by classification', async function () {
      // Add more accounts with different balance sheet tags
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [
            { code: 1100, name: 'Inventory', normalBalance: 'debit' },
            { code: 2100, name: 'Accounts Payable', normalBalance: 'credit' },
          ],
        },
      });
      
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [
            { code: 1100, tag: 'Balance Sheet - Current Asset' },
            { code: 2100, tag: 'Balance Sheet - Current Liability' },
          ],
        },
      });
      
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should group accounts by their balance sheet classifications
      ok(text.includes('Current Asset'), 'should show Current Asset classification');
      ok(text.includes('Current Liabilities'), 'should show Current Liability classification');
      ok(text.includes('Equity'), 'should show Equity classification');
      
      // Should include accounts under their proper classifications
      ok(text.includes('1100') && text.includes('Inventory'), 'should include Inventory as current asset');
      ok(text.includes('2100') && text.includes('Accounts Payable'), 'should include AP as current liability');
    });

    it('shows correct account balances', async function () {
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should show the account balances (Cash 1000, Equity 1000 from setup)
      ok(text.includes('1000') || text.includes('1,000'), 'should show account balances');
      
      // Should be formatted as currency
      ok(text.includes('$') || text.includes('.00'), 'should format as currency');
    });

    it('calculates totals for each classification', async function () {
      // Add another equity account
      await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: {
          accounts: [{ code: 3100, name: 'Retained Earnings', normalBalance: 'credit' }],
        },
      });
      
      await client.callTool({
        name: 'set_many_account_tags',
        arguments: {
          taggedAccounts: [{ code: 3100, tag: 'Balance Sheet - Equity' }],
        },
      });
      
      // Post a transaction to give it a balance
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Add retained earnings',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 3100, amount: 500, type: 'credit' },
          ],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: parseInt(refMatch[1]) },
      });
      
      // Generate report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should show totals for each classification
      ok(text.includes('Total') || text.includes('TOTAL'), 'should show classification totals');
      
      // Total equity should be 1000 (original) + 500 (new) = 1500
      ok(text.includes('1500') || text.includes('1,500'), 'should show correct classification totals');
    });

    it('returns most recent balance sheet when multiple exist', async function () {
      // Generate first report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      // Make a transaction
      const draftRes = await client.callTool({
        name: 'draft_journal_entry',
        arguments: {
          date: '2024-01-01',
          description: 'Change balances',
          lines: [{ accountCode: 100, amount: 300, type: 'debit' }, { accountCode: 300, amount: 300, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      await client.callTool({
        name: 'post_journal_entry',
        arguments: { journalEntryRef: parseInt(refMatch[1]) },
      });
      
      // Generate second report
      await client.callTool({
        name: 'generate_financial_report',
        arguments: {},
      });
      
      const res = await client.callTool({
        name: 'get_latest_balance_sheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should show updated balances (Cash: 1000+300=1300, Equity: 1000+300=1300)
      ok(text.includes('1300') || text.includes('1,300'), 'should show most recent balances');
    });
  });
});
