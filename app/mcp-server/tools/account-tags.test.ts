import { ok } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/mcp-server/mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertArray, assertPropDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('AccountTagsMCPTools', function () {
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
    });
  });

  describe('Tool: unsetManyAccountTags', function () {
    beforeEach(async function () {
      // Set up some tags first
      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 100, tag: 'Current Asset' },
            { code: 200, tag: 'Revenue' },
          ],
        },
      });
    });

    it('removes tags from multiple accounts', async function () {
      const res = await client.callTool({
        name: 'unsetManyAccountTags',
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
      ok(responseText.includes('Tag "Asset" removed from account 100'), 'should confirm Asset tag removal');
      ok(responseText.includes('Tag "Revenue" removed from account 200'), 'should confirm Revenue tag removal');
      
      // Verify tags were actually removed
      const verifyRes = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT account_code, tag FROM account_tag WHERE account_code IN (100, 200) ORDER BY account_code, tag',
        },
      });
      const verifyText = (verifyRes.content[0] as { text: string }).text;
      
      // The only remaining tag should be "Current Asset" for account 100
      const lines = verifyText.split('\n').filter(line => line.includes('100') || line.includes('200'));
      const remainingTags = lines.filter(line => (line.includes('100') && line.includes('Asset') && !line.includes('Current')) || (line.includes('200') && line.includes('Revenue')));
      ok(remainingTags.length === 0, 'should have removed the specific Asset and Revenue tags');
      ok(verifyText.includes('Current Asset'), 'should still have Current Asset tag');
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
      ok(responseText.includes('No tagged accounts provided, nothing to do.'), 'should handle empty list');
    });

    it('handles removal of non-existent tags gracefully', async function () {
      const res = await client.callTool({
        name: 'unsetManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'NonExistent' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Tag "NonExistent" removed from account 100'), 'should confirm removal attempt');
    });
  });
});
