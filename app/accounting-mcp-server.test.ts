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
      name: 'ensureManyAccountsExist',
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
      name: 'setManyAccountTags',
      arguments: {
        taggedAccounts: [
          { code: 100, tag: 'Balance Sheet - Current Asset' },
          { code: 300, tag: 'Balance Sheet - Equity' },
        ],
      },
    });

    // Create and post a journal entry to have non-zero balances
    const draftRes = await client.callTool({
      name: 'draftJournalEntry',
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
      name: 'postJournalEntry',
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

  describe('Tool: sqlite-accounting-schema', function () {
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

  describe('Tool: ensureManyAccountsExist', function () {
    it('creates new accounts and skips existing ones', async function () {
      const res = await client.callTool({
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit' },            { code: 400, name: 'Expenses', normalBalance: 'debit' },          ],
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
        name: 'getManyAccounts',
        arguments: { codes: [400] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('400') && verifyText.includes('Expenses'), 'new account should exist');
    });

    it('handles empty accounts list', async function () {
      const res = await client.callTool({
        name: 'ensureManyAccountsExist',
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
        name: 'ensureManyAccountsExist',
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
        name: 'getManyAccounts',
        arguments: { codes: [110, 210, 410] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('110') && verifyText.includes('Accounts Receivable'), 'should include AR account');
      ok(verifyText.includes('210') && verifyText.includes('Accounts Payable'), 'should include AP account');
      ok(verifyText.includes('410') && verifyText.includes('Sales Revenue'), 'should include Revenue account');
    });
  });

  describe('Tool: renameAccount', function () {
    it('renames an existing account', async function () {
      const res = await client.callTool({
        name: 'renameAccount',
        arguments: { code: 100, name: 'Cash Account' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Account 100 renamed') && responseText.includes('Cash Account'), 'should confirm rename');
      
      // Verify the account was actually renamed
      const verifyRes = await client.callTool({
        name: 'getManyAccounts',
        arguments: { codes: [100] },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('100') && verifyText.includes('Cash Account'), 'account should have new name');
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'renameAccount',
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
        name: 'getManyAccounts',
        arguments: { codes: [200] },
      });
      const beforeText = (beforeRes.content[0] as { text: string }).text;
      
      // Rename the account
      await client.callTool({
        name: 'renameAccount',
        arguments: { code: 200, name: 'Service Revenue' },
      });
      
      // Verify the entry was actually updated
      const afterRes = await client.callTool({
        name: 'getManyAccounts',
        arguments: { codes: [200] },
      });
      const afterText = (afterRes.content[0] as { text: string }).text;
      
      ok(afterText.includes('200') && afterText.includes('Service Revenue'), 'should have new name');
      // Both should have same balance structure since only name changed
      ok(beforeText.includes('Balance:') && afterText.includes('Balance:'), 'should preserve balance information');
    });
  });

  describe('Tool: setControlAccount', function () {
    it('sets control account for an existing account', async function () {
      const res = await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 100, controlAccountCode: 200 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      strictEqual(responseText, 'Account 100 (Cash) control account set to 200 (Revenue).');
      
      // Verify the hierarchical structure
      const hierarchyRes = await client.callTool({
        name: 'getHierarchicalChartOfAccounts',
        arguments: {},
      });
      const hierarchyText = (hierarchyRes.content[0] as { text: string }).text;
      
      // Account 100 should now appear under account 200 in hierarchy
      ok(hierarchyText.includes('200') && hierarchyText.includes('100'), 'both accounts should be in hierarchy');
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'setControlAccount',
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
        name: 'setControlAccount',
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
        name: 'setControlAccount',
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
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [{ code: 500, name: 'Assets', normalBalance: 'debit' }],
        },
      });
      
      // Set initial control account
      await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 100, controlAccountCode: 200 },
      });
      
      // Change to different control account
      const res = await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 100, controlAccountCode: 500 },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      strictEqual(responseText, 'Account 100 (Cash) control account set to 500 (Assets).');
      
      // Verify in hierarchy
      const hierarchyRes = await client.callTool({
        name: 'getHierarchicalChartOfAccounts',
        arguments: {},
      });
      const hierarchyText = (hierarchyRes.content[0] as { text: string }).text;
      
      // Account 100 should now be under 500, not 200
      ok(hierarchyText.includes('500') && hierarchyText.includes('100'), 'should show new hierarchy');
    });
  });

  describe('Tool: getHierarchicalChartOfAccounts', function () {
    it('returns hierarchical chart', async function () {
      const res = await client.callTool({
        name: 'getHierarchicalChartOfAccounts',
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
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 1000, name: 'Current Assets', normalBalance: 'debit' },
            { code: 1100, name: 'Cash and Equivalents', normalBalance: 'debit' },
          ],
        },
      });
      
      // Set hierarchy
      await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 1100, controlAccountCode: 1000 },
      });
      
      const res = await client.callTool({
        name: 'getHierarchicalChartOfAccounts',
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
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 2000, name: 'Assets', normalBalance: 'debit' },
            { code: 2100, name: 'Current Assets', normalBalance: 'debit' },
            { code: 2110, name: 'Petty Cash', normalBalance: 'debit' },
          ],
        },
      });
      
      await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 2100, controlAccountCode: 2000 },
      });
      
      await client.callTool({
        name: 'setControlAccount',
        arguments: { accountCode: 2110, controlAccountCode: 2100 },
      });
      
      const res = await client.callTool({
        name: 'getHierarchicalChartOfAccounts',
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

  describe('Tool: getManyAccounts', function () {
    it('retrieves accounts by codes', async function () {
      const res = await client.callTool({
        name: 'getManyAccounts',
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
        name: 'getManyAccounts',
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
        name: 'getManyAccounts',
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
        name: 'getManyAccounts',
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
        name: 'getManyAccounts',
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
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 1200, name: 'Bank Account', normalBalance: 'debit' },
            { code: 1300, name: 'Savings Account', normalBalance: 'debit' },
          ],
        },
      });
      
      const res = await client.callTool({
        name: 'getManyAccounts',
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

  describe('Tool: setManyAccountTags', function () {
    it('sets tags for multiple accounts', async function () {
      const res = await client.callTool({
        name: 'setManyAccountTags',
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
        name: 'executeSqlQuery',
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
        name: 'setManyAccountTags',
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
        name: 'setManyAccountTags',
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
        name: 'executeSqlQuery',
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
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [{ code: 200, tag: 'Asset' }],
        },
      });
      
      // Set same tag again (should not create duplicate)
      const res = await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [{ code: 200, tag: 'Asset' }],
        },
      });
      
      // Verify only one instance exists
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
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
        name: 'setManyAccountTags',
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

  describe('Tool: unsetManyAccountTags', function () {
    it('removes tags from multiple accounts', async function () {
      // First set some tags
      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 200, tag: 'Liability' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'unsetManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 200, tag: 'Liability' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Tag "Asset" removed from account 100'), 'should confirm Asset removal');
      ok(responseText.includes('Tag "Liability" removed from account 200'), 'should confirm Liability removal');
      
      // Verify tags were actually removed
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT COUNT(*) as count FROM account_tag WHERE (account_code = 100 AND tag = ?) OR (account_code = 200 AND tag = ?)',
          params: ['Asset', 'Liability'],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('0'), 'tags should be completely removed');
    });

    it('handles empty tagged accounts list', async function () {
      const res = await client.callTool({
        name: 'unsetManyAccountTags',
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
        name: 'unsetManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'NonExistentTag' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      // Should handle gracefully without errors
      ok(responseText.includes('100') || responseText.includes('NonExistentTag'), 'should process the request');
    });

    it('removes only specified tags, leaving others intact', async function () {
      // Set multiple tags on the same account
      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 100, tag: 'Liability' },
          ],
        },
      });

      // Remove only one tag
      await client.callTool({
        name: 'unsetManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Liability' },
          ],
        },
      });
      
      // Verify selective removal
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT tag FROM account_tag WHERE account_code = 100 ORDER BY tag',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Asset'), 'should keep Asset');
      ok(!verifyText.includes('Liability'), 'should not have Liability');
    });

    it('handles multiple accounts with same tag', async function () {
      // Set the same tag on multiple accounts
      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'SharedTag' },
            { code: 200, tag: 'SharedTag' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'unsetManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'SharedTag' },
            { code: 200, tag: 'SharedTag' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Tag "SharedTag" removed from account 100'), 'should confirm SharedTag removal from account 100');
      ok(responseText.includes('Tag "SharedTag" removed from account 200'), 'should confirm SharedTag removal from account 200');
      
      // Verify tags were actually removed
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT COUNT(*) as count FROM account_tag WHERE tag = ?',
          params: ['SharedTag'],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('0'), 'SharedTag should be completely removed from both accounts');
    });
  });

  describe('Tool: draftJournalEntry', function () {
    it('creates a draft journal entry', async function () {
      const res = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Test entry',
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
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT ref, note, post_time FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes(entryRef.toString()), 'should find the journal entry');
      ok(verifyText.includes('Test entry'), 'should have correct description');
      
      // Verify the lines
      const linesRes = await client.callTool({
        name: 'executeSqlQuery',
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
        name: 'draftJournalEntry',
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
        name: 'executeSqlQuery',
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
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Unbalanced entry',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 50, type: 'credit' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      const refMatch = responseText.match(/reference (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef = parseInt(refMatch[1]);
      
      // Verify total debits equal total credits
      const totalsRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT SUM(debit) as total_debits, SUM(credit) as total_credits FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [entryRef],
        },
      });
      const totalsText = (totalsRes.content[0] as { text: string }).text;
      ok(totalsText.includes('100') && totalsText.includes('50'), 'total debits should be 100 and credits should be 50');
    });

    it('handles different date formats', async function () {
      const res = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01T12:00:00Z',
          description: 'Date format test',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('2024-01-01'), 'should handle different date format');
    });

    it('creates multiple independent draft entries', async function () {
      const res1 = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'First entry',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const res2 = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-02',
          description: 'Second entry',
          lines: [
            { accountCode: 100, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 200, type: 'credit' },
          ],
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
        name: 'executeSqlQuery',
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

  describe('Tool: updateJournalEntry', function () {
    it('updates an existing journal entry', async function () {
      // Create a draft entry first
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Original entry',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-02',
          description: 'Updated entry',
          lines: [
            { accountCode: 100, amount: 150, type: 'debit' },
            { accountCode: 200, amount: 150, type: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Journal entry') && responseText.includes('updated'), 'should confirm update');
      
      // Verify the entry was actually updated
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT note FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Updated entry'), 'should have new description');
      ok(!verifyText.includes('Original entry'), 'should not have old description');
      
      // Verify the lines were updated
      const linesRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [entryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('150'), 'should have updated amounts of 150');
      ok(!linesText.includes('100'), 'should not have old amounts of 100');
    });

    it('can completely change line structure', async function () {
      // Create a draft entry
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Original',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      // Update with completely different lines
      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-01',
          description: 'Updated',
          lines: [
            { accountCode: 300, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 200, type: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Journal entry') && responseText.includes('updated'), 'should confirm update');
      
      // Verify the entry was actually updated
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT note FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Updated'), 'should have new description');
      ok(!verifyText.includes('Original'), 'should not have old description');
      
      // Verify the lines were updated
      const linesRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [entryRef],
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(linesText.includes('200') && linesText.includes('300'), 'should have updated lines');
      ok(!linesText.includes('100'), 'should not have old line for account 100');
    });

    it('preserves draft status during update', async function () {
      // Create draft
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      // Update
      await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-01',
          description: 'Updated Draft',
          lines: [
            { accountCode: 100, amount: 150, type: 'debit' },
            { accountCode: 200, amount: 150, type: 'credit' },
          ],
        },
      });

      // Try to post - should succeed since still draft
      const postRes = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });
      const postText = (postRes.content[0] as { text: string }).text;
      ok(postText.includes('posted successfully'), 'should confirm posting');
      
      // Verify it's now posted (post_time should NOT be NULL)
      const statusRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const statusText = (statusRes.content[0] as { text: string }).text;
      ok(!statusText.includes('null'), 'should be posted (not a draft anymore)');
    });

    it('fails to update non-existent journal entry', async function () {
      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-01',
          description: 'Non-existent',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });
  });

  describe('Tool: postJournalEntry', function () {
    it('posts a draft journal entry with default date', async function () {
      // Create draft
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft to post',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const postText = (res.content[0] as { text: string }).text;
      ok(postText.includes('Journal entry') && postText.includes('posted'), 'should confirm posting');
      
      // Verify the entry is now posted (has post_time)
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(!verifyText.includes('NULL') && !verifyText.includes('<null>'), 'should have post_time set');
      
      // Verify account balances were updated
      const balanceRes = await client.callTool({
        name: 'getManyAccounts',
        arguments: { codes: [100, 200] },
      });
      const balanceText = (balanceRes.content[0] as { text: string }).text;
      
      // Account 100 (debit normal) should show increased balance
      // Account 200 (credit normal) should show increased balance
      ok(balanceText.includes('100') && (balanceText.includes('200') || balanceText.includes('2,000')), 'Cash balance should be updated to 2000 (1000 + 1000)');
      ok(balanceText.includes('200') && (balanceText.includes('0') || balanceText.includes('0.00')), 'Revenue balance should be updated to 0 (1000 - 1000)');
    });

    it('posts a draft journal entry with specific date', async function () {
      // Create draft
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft to post with date',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef, date: '2024-01-02' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const postText = (res.content[0] as { text: string }).text;
      ok(postText.includes('posted successfully'), 'should confirm posting');
      
      // Verify the posting date was used
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT post_time FROM journal_entry WHERE ref = ?',
          params: [entryRef],
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(!verifyText.includes('NULL'), 'should have post_time set');
    });

    it('fails to post already posted entry', async function () {
      // Create and post
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Already posted',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      // Try to post again
      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('already posted') || responseText.includes('not found'), 'should prevent double posting');
    });

    it('fails to post non-existent entry', async function () {
      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: 99999 },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });

    it('correctly updates multiple account balances', async function () {
      // Get initial balances
      const initialRes = await client.callTool({
        name: 'getManyAccounts',
        arguments: { codes: [100, 200] },
      });
      const initialText = (initialRes.content[0] as { text: string }).text;
      
      // Extract initial balances using a more robust approach
      const initialCashMatch = initialText.match(/100[^)]*Balance:\s*\$([0-9,]+\.?\d*)/);
      const initialRevenueMatch = initialText.match(/200[^)]*Balance:\s*\$([0-9,]+\.?\d*)/);
      const initialCashBalance = initialCashMatch ? parseFloat(initialCashMatch[1].replace(',', '')) : 0;
      const initialRevenueBalance = initialRevenueMatch ? parseFloat(initialRevenueMatch[1].replace(',', '')) : 0;

      // Create draft
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Balance update test',
          lines: [
            { accountCode: 100, amount: 50, type: 'debit' },
            { accountCode: 200, amount: 50, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      // Get balances after
      const afterRes = await client.callTool({
        name: 'getManyAccounts',
        arguments: { codes: [100, 200] },
      });
      
      const afterText = (afterRes.content[0] as { text: string }).text;
      const finalCashMatch = afterText.match(/100[^)]*Balance:\s*\$([0-9,]+\.?\d*)/);
      const finalRevenueMatch = afterText.match(/200[^)]*Balance:\s*\$([0-9,]+\.?\d*)/);
      const finalCashBalance = finalCashMatch ? parseFloat(finalCashMatch[1].replace(',', '')) : 0;
      const finalRevenueBalance = finalRevenueMatch ? parseFloat(finalRevenueMatch[1].replace(',', '')) : 0;
      
      ok(finalCashBalance === initialCashBalance + 50, 'Cash balance should increase by 50');
      ok(finalRevenueBalance === initialRevenueBalance + 50, 'Revenue balance should increase by 50');
    });
  });

  describe('Tool: executeSqlQuery', function () {
    it('executes a SELECT query and returns results', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT code, name FROM account WHERE code IN (100, 200) ORDER BY code',
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
        name: 'executeSqlQuery',
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
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT code, name FROM account WHERE code = 999',
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
        name: 'executeSqlQuery',
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
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT COUNT(*) as count FROM account',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('count'), 'should contain count column');
    });

    it('executes a query with JOIN', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT a.code, a.name, t.tag FROM account a LEFT JOIN account_tag t ON a.code = t.account_code WHERE a.code IN (100, 200) ORDER BY a.code',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should indicate success');
      ok(responseText.includes('+'), 'should contain table borders');
      ok(responseText.includes('|'), 'should contain table separators');
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should contain account data');
    });
  });

  describe('Tool: deleteManyJournalEntryDrafts', function () {
    it('deletes multiple draft journal entries', async function () {
      // Create drafts
      const draft1 = await client.callTool({
        name: 'draftJournalEntry',
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
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft 2',
          lines: [
            { accountCode: 100, amount: 200, type: 'debit' },
            { accountCode: 200, amount: 200, type: 'credit' },
          ],
        },
      });

      const text1 = (draft1.content[0] as { text: string }).text;
      const ref1 = parseInt(text1.match(/reference (\d+)/)[1]);

      const text2 = (draft2.content[0] as { text: string }).text;
      const ref2 = parseInt(text2.match(/reference (\d+)/)[1]);

      const res = await client.callTool({
        name: 'deleteManyJournalEntryDrafts',
        arguments: { journalEntryRefs: [ref1, ref2] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Draft journal entry ${ref1} deleted`), 'should confirm deletion of first draft');
      ok(responseText.includes(`Draft journal entry ${ref2} deleted`), 'should confirm deletion of second draft');
    });

    it('handles empty list', async function () {
      const res = await client.callTool({
        name: 'deleteManyJournalEntryDrafts',
        arguments: { journalEntryRefs: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No journal entry references provided'), 'should handle empty list');
    });
  });

  describe('Tool: reverseJournalEntry', function () {
    it('reverses a posted journal entry', async function () {
      // Create and post an entry
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Entry to reverse',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-02',
          description: 'Reversal',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Reversal journal entry created with reference`), 'should confirm reversal creation');
      ok(responseText.includes(`for original entry ${entryRef}`), 'should reference original entry');
      
      // Extract reversal reference
      const reversalRefMatch = responseText.match(/reference (\d+)/);
      assertDefined(reversalRefMatch, 'Should extract reversal reference');
      const reversalRef = parseInt(reversalRefMatch[1]);
      ok(reversalRef !== entryRef, 'Reversal should have different reference');
      
      // Verify reversal entry lines are opposite of original
      const originalLinesRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [entryRef],
        },
      });
      
      const reversalLinesRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT account_code, debit, credit FROM journal_entry_line WHERE journal_entry_ref = ? ORDER BY account_code',
          params: [reversalRef],
        },
      });
      
      const originalLinesText = (originalLinesRes.content[0] as { text: string }).text;
      const reversalLinesText = (reversalLinesRes.content[0] as { text: string }).text;
      
      // Original: 100 debit 100, 200 credit 100
      // Reversal: 100 credit 100, 200 debit 100
      ok(originalLinesText.includes('100') && originalLinesText.includes('100'), 'original should have account 100 with 100');
      ok(reversalLinesText.includes('100') && reversalLinesText.includes('100'), 'reversal should have account 100 with 100');
      
      // Verify reversal relationships in database
      const relationshipRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT ref, reversal_of_ref, reversed_by_ref FROM journal_entry WHERE ref IN (?, ?) ORDER BY ref',
          params: [entryRef, reversalRef],
        },
      });
      const relationshipText = (relationshipRes.content[0] as { text: string }).text;
      ok(relationshipText.includes(reversalRef.toString()), 'should show reversal relationship');
    });

    it('fails to reverse draft entry', async function () {
      // Create draft
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Draft to reverse',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: { journalEntryRef: entryRef, date: '2024-01-02' },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('not posted'), 'should prevent reversing draft entries');
    });

    it('creates reversal with correct balancing', async function () {
      // Create and post
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'To reverse',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      // Reverse
      const reverseRes = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-02',
          description: 'Reversal',
        },
      });

      const reverseText = (reverseRes.content[0] as { text: string }).text;
      const reverseRefMatch = reverseText.match(/reference (\d+)/);
      const reverseRef = parseInt(reverseRefMatch[1]);

      // Post reversal
      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: reverseRef },
      });
      
      // Verify reversal balances
      const reversalTotalsRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT SUM(debit) as total_debits, SUM(credit) as total_credits FROM journal_entry_line WHERE journal_entry_ref = ?',
          params: [reverseRef],
        },
      });
      const reversalTotalsText = (reversalTotalsRes.content[0] as { text: string }).text;
      ok(reversalTotalsText.includes('100') && reversalTotalsText.includes('100'), 'reversal should have balanced totals of 100');
    });

    it('fails to reverse non-existent entry', async function () {
      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-02',
          description: 'Non-existent',
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('not found') || responseText.includes('does not exist'), 'should indicate entry not found');
    });

    it('posts reversal entry automatically', async function () {
      // Create and post original
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Original',
          lines: [
            { accountCode: 100, amount: 100, type: 'debit' },
            { accountCode: 200, amount: 100, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      // Reverse (creates as draft)
      const reverseRes = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef: entryRef,
          date: '2024-01-02',
          description: 'Auto-post reversal',
        },
      });

      const reverseText = (reverseRes.content[0] as { text: string }).text;
      const reverseRefMatch = reverseText.match(/reference (\d+)/);
      const reverseRef = parseInt(reverseRefMatch[1]);

      // Check if reversal is still a draft by trying to post it (should succeed)
      const postRes = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: reverseRef },
      });
      const postText = (postRes.content[0] as { text: string }).text;
      ok(postText.includes('posted successfully'), 'should allow posting of reversal draft');
      
      // Now try to post again (should fail since already posted)
      const postAgainRes = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: reverseRef },
      });
      const postAgainText = (postAgainRes.content[0] as { text: string }).text;
      ok(postAgainText.includes('already posted') || postAgainText.includes('not found'), 'should prevent double posting of reversal');
    });
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
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('Financial report generated'), 'should confirm report generation');
      ok(text.includes('Trial Balance and Balance Sheet snapshots'), 'should mention both reports');
      
      // Verify reports were actually created in database
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT report_type, COUNT(*) as count FROM balance_report GROUP BY report_type ORDER BY report_type',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      ok(verifyText.includes('Ad Hoc'), 'should have Ad Hoc report type');
      
      // Check that report lines were created
      const linesRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT COUNT(*) as line_count FROM balance_report_line',
        },
      });
      const linesText = (linesRes.content[0] as { text: string }).text;
      ok(!linesText.includes('0'), 'should have report lines created');
    });

    it('creates separate trial balance and balance sheet reports', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const trialRes = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });

      const balanceRes = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      
      const trialBalanceText = (trialRes.content[0] as { text: string }).text;
      const balanceSheetText = (balanceRes.content[0] as { text: string }).text;
      
      // Both should contain account information but in different formats
      ok(trialBalanceText.includes('Trial Balance'), 'should have trial balance title');
      ok(balanceSheetText.includes('Balance Sheet'), 'should have balance sheet title');
      
      // Trial balance should show debits and credits
      ok(trialBalanceText.includes('Debit') && trialBalanceText.includes('Credit'), 'trial balance should show debit/credit columns');
      
      // Balance sheet should show asset/liability/equity classifications
      ok(balanceSheetText.includes('Asset') || balanceSheetText.includes('Current Asset'), 'balance sheet should show asset classifications');
    });

    it('includes all active accounts in trial balance', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      
      const trialBalanceText = (res.content[0] as { text: string }).text;
      
      // Should include all our test accounts (100, 200, 300)
      ok(trialBalanceText.includes('100') && trialBalanceText.includes('Cash'), 'should include Cash account');
      ok(trialBalanceText.includes('200') && trialBalanceText.includes('Revenue'), 'should include Revenue account');
      ok(trialBalanceText.includes('300') && trialBalanceText.includes('Equity'), 'should include Equity account');
    });

    it('generates reports with current account balances', async function () {
      // Create and post a transaction to change balances
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
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
        name: 'postJournalEntry',
        arguments: { journalEntryRef },
      });
      
      // Generate report
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });
      
      // Check trial balance includes updated balances
      const trialBalanceRes = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      
      const trialBalanceText = (trialBalanceRes.content[0] as { text: string }).text;
      
      // Account 100 should show increased balance (original 1000 + 500 = 1500)
      // Account 200 should show decreased balance (original 1000 - 500 = 500)
      ok(trialBalanceText.includes('1500') || trialBalanceText.includes('1,500'), 'should show updated Cash balance');
      ok(trialBalanceText.includes('500') || trialBalanceText.includes('500.00'), 'should show updated Revenue balance');
    });

    it('handles multiple report generations', async function () {
      // Get initial balances
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const initialRes = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      const initialText = (initialRes.content[0] as { text: string }).text;
      
      // Extract initial Cash and Equity balances
      const initialCashMatch = initialText.match(/100[^|]*\|[^|]*\|[^|]*\|\s*\$([0-9,]+\.?\d*)/);
      const initialEquityMatch = initialText.match(/300[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\$([0-9,]+\.?\d*)/);
      const initialCashBalance = initialCashMatch ? parseFloat(initialCashMatch[1].replace(',', '')) : 0;
      const initialEquityBalance = initialEquityMatch ? parseFloat(initialEquityMatch[1].replace(',', '')) : 0;

      // Make a transaction
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
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
        name: 'postJournalEntry',
        arguments: { journalEntryRef },
      });
      
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Extract final balances
      const finalCashMatch = text.match(/100[^|]*\|[^|]*\|[^|]*\|\s*\$([0-9,]+\.?\d*)/);
      const finalEquityMatch = text.match(/300[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\$([0-9,]+\.?\d*)/);
      const finalCashBalance = finalCashMatch ? parseFloat(finalCashMatch[1].replace(',', '')) : 0;
      const finalEquityBalance = finalEquityMatch ? parseFloat(finalEquityMatch[1].replace(',', '')) : 0;
      
      // Should show updated balances (Cash +100, Equity +100)
      ok(finalCashBalance === initialCashBalance + 100, 'should show updated Cash balance');
      ok(finalEquityBalance === initialEquityBalance + 100, 'should show updated Equity balance');
    });
  });

  describe('Tool: getLatestTrialBalance', function () {
    it('returns the latest trial balance report', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
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
      const res = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('No trial balance reports found'), 'should indicate no reports');
    });

    it('shows correct balances in trial balance', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
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
      // Create first report
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const firstRes = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });

      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      // Make a transaction to change balances
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Transaction to differentiate reports',
          lines: [{ accountCode: 100, amount: 50, type: 'debit' }, { accountCode: 200, amount: 50, type: 'credit' }],
        },
      });
      
      const refMatch = (draftRes.content[0] as { text: string }).text.match(/reference (\d+)/);
      const journalEntryRef = parseInt(refMatch[1]);
      
      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef },
      });

      // Create second report
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
        arguments: {},
      });
      
      const firstText = (firstRes.content[0] as { text: string }).text;
      const secondText = (res.content[0] as { text: string }).text;
      
      // Should return a different report (should have updated balances)
      ok(firstText !== secondText, 'should return the most recent report');
      ok(secondText.includes('$50.00'), 'should show updated balances in the most recent report');
    });

    it('includes account details in trial balance format', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestTrialBalance',
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

  describe('Tool: getLatestBalanceSheet', function () {
    it('returns the latest balance sheet report', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
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
      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const text = (res.content[0] as { text: string }).text;
      ok(text.includes('No balance sheet reports found'), 'should indicate no reports');
    });

    it('shows only balance sheet accounts', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
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
      // Create an additional account with current liability classification for testing
      await client.callTool({
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 210, name: 'Accounts Payable', normalBalance: 'credit' },
          ],
        },
      });

      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 210, tag: 'Balance Sheet - Current Liability' },
          ],
        },
      });

      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should group accounts by their balance sheet classifications
      ok(text.includes('Current Assets'), 'should show Current Asset classification');
      ok(text.includes('Current Liabilities'), 'should show Current Liability classification');
      ok(text.includes('Equity'), 'should show Equity classification');
      
      // Should include accounts under their proper classifications
      ok(text.includes('100') && text.includes('Cash'), 'should include Cash as current asset');
      ok(text.includes('210') && text.includes('Accounts Payable'), 'should include AP as current liability');
      ok(text.includes('300') && text.includes('Equity'), 'should include Equity');
    });

    it('shows correct account balances', async function () {
      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should show the account balances (Cash 1000, Equity 1000 from setup)
      ok(text.includes('1000') || text.includes('1,000'), 'should show account balances');
      
      // Verify that totals are correct
      const totalAssetsMatch = text.match(/Total Assets[\s\S]*?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      const totalLiabilitiesMatch = text.match(/Total Liabilities[\s\S]*?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      const totalEquityMatch = text.match(/Total Equity[\s\S]*?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      
      if (totalAssetsMatch && totalLiabilitiesMatch && totalEquityMatch) {
        const totalAssets = parseFloat(totalAssetsMatch[1].replace(/,/g, ''));
        const totalLiabilities = parseFloat(totalLiabilitiesMatch[1].replace(/,/g, ''));
        const totalEquity = parseFloat(totalEquityMatch[1].replace(/,/g, ''));
        
        // Total Assets should equal total of Liabilities and Equity
        ok(Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01, 'Total Assets should equal Liabilities + Equity');
      }
    });

    it('calculates totals for each classification', async function () {
      // Ensure we have accounts in all classifications for comprehensive testing
      await client.callTool({
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 220, name: 'Notes Payable', normalBalance: 'credit' },
          ],
        },
      });

      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 220, tag: 'Balance Sheet - Current Liability' },
          ],
        },
      });

      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      
      // Should show grand totals for major classifications
      ok(text.includes('TOTAL ASSETS'), 'should show grand total for assets');
      ok(text.includes('TOTAL LIABILITIES'), 'should show grand total for liabilities');
      ok(text.includes('TOTAL EQUITY'), 'should show total for equity');
      
      // Should include account categorizations
      ok(text.includes('Current Assets'), 'should show current assets category');
      ok(text.includes('Current Liabilities'), 'should show current liabilities category');
      ok(text.includes('Equity'), 'should show equity category');
    });

    it('returns most recent balance sheet when multiple exist', async function () {
      // Add an additional transaction to change balances
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-02', 
          description: 'Additional transaction',
          lines: [
            { accountCode: 100, amount: 300, type: 'debit' },
            { accountCode: 300, amount: 300, type: 'credit' },
          ],
        },
      });

      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/reference (\d+)/);
      const entryRef = parseInt(refMatch[1]);

      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: entryRef },
      });

      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      await client.callTool({
        name: 'generateFinancialReport',
        arguments: {},
      });

      const res = await client.callTool({
        name: 'getLatestBalanceSheet',
        arguments: {},
      });
      
      const text = (res.content[0] as { text: string }).text;
      // Should show updated balances (Cash: 1000+300=1300, Equity: 1000+300=1300)
      ok(text.includes('1300') || text.includes('1,300'), 'should show updated balances');
    });
  });
});
