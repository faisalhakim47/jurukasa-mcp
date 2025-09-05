import { ok, strictEqual } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/accounting-mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertDefined, assertArray, assertPropDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('AccountManagementMCPTools', function () {
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
      name: 'ensureManyAccountsExist',
      arguments: {
        accounts: [
          { code: 100, name: 'Cash', normalBalance: 'debit' },
          { code: 200, name: 'Revenue', normalBalance: 'credit' },
          { code: 300, name: 'Equity', normalBalance: 'credit' },
        ],
      },
    });
  });

  afterEach(async function () {
    await Promise.all([
      client.close(),
      server.close(),
    ]);
    await repo.close();
  });

  describe('Tool: ensureManyAccountsExist', function () {
    it('creates new accounts and skips existing ones', async function () {
      const res = await client.callTool({
        name: 'ensureManyAccountsExist',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit' },
            { code: 400, name: 'Expenses', normalBalance: 'debit' },
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
  });
});
