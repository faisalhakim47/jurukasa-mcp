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
      name: 'ManageManyAccounts',
      arguments: {
        accounts: [
          { accountCode: 100, name: 'Cash', normalBalance: 'debit' },
          { accountCode: 200, name: 'Revenue', normalBalance: 'credit' },
          { accountCode: 300, name: 'Equity', normalBalance: 'credit' },
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

  describe('Tool: SetManyAccountTags', function () {
    it('sets tags for multiple accounts', async function () {
      const res = await client.callTool({
        name: 'SetManyAccountTags',
        arguments: {
          accountTags: [
            { accountCode:100, tag: 'Asset' },
            { accountCode:200, tag: 'Revenue' },
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
        name: 'ExecuteSqlQuery',
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
        name: 'SetManyAccountTags',
        arguments: { accountTags: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No tagged accounts provided, nothing to do.'), 'should handle empty list');
    });

    it('handles multiple tags for same account', async function () {
      const res = await client.callTool({
        name: 'SetManyAccountTags',
        arguments: {
          accountTags: [
            { accountCode:100, tag: 'Current Asset' },
            { accountCode:100, tag: 'Asset' },
            { accountCode:100, tag: 'Cash Flow - Cash Equivalents' },
          ],
        },
      });
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Current Asset'), 'should set Current Asset tag');
      ok(responseText.includes('Asset'), 'should set Asset tag');
      ok(responseText.includes('Cash Flow - Cash Equivalents'), 'should set Cash Flow - Cash Equivalents tag');
    });
  });

  describe('Tool: UnsetManyAccountTags', function () {
    beforeEach(async function () {
      // Set up some tags first
      await client.callTool({
        name: 'SetManyAccountTags',
        arguments: {
          accountTags: [
            { accountCode:100, tag: 'Asset' },
            { accountCode:100, tag: 'Current Asset' },
            { accountCode:200, tag: 'Revenue' },
          ],
        },
      });
    });

    it('removes tags from multiple accounts', async function () {
      const res = await client.callTool({
        name: 'UnsetManyAccountTags',
        arguments: {
          accountTags: [
            { accountCode:100, tag: 'Asset' },
            { accountCode:200, tag: 'Revenue' },
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
        name: 'ExecuteSqlQuery',
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
        name: 'UnsetManyAccountTags',
        arguments: { accountTags: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No tagged accounts provided, nothing to do.'), 'should handle empty list');
    });

    it('handles removal of non-existent tags gracefully', async function () {
      const res = await client.callTool({
        name: 'UnsetManyAccountTags',
        arguments: {
          accountTags: [
            { accountCode:100, tag: 'NonExistent' },
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

  describe('Resource: Account Tags', function () {
    it('lists resources in server resource list', async function () {
      const resources = await client.listResources();
      assertPropDefined(resources, 'resources');
      assertArray(resources.resources);

      const tagResources = resources.resources.filter(r => r.uri.startsWith('account-tags://'));
      ok(tagResources.length === 2, 'should have 2 account tag resources');

      const referenceResource = tagResources.find(r => r.uri === 'account-tags://reference');
      const dataResource = tagResources.find(r => r.uri === 'account-tags://data');

      ok(referenceResource, 'should have reference resource');
      ok(dataResource, 'should have data resource');
      ok(referenceResource?.mimeType === 'text/markdown', 'reference should be markdown');
      ok(dataResource?.mimeType === 'application/json', 'data should be JSON');
    });

    it('provides account tags reference resource', async function () {
      const res = await client.readResource({ uri: 'account-tags://reference' });
      assertPropDefined(res, 'contents');
      assertArray(res.contents);
      ok(res.contents.length > 0, 'resource should have content');

      const content = res.contents[0] as { mimeType: string; text: string };
      ok(content.mimeType === 'text/markdown', 'should be markdown format');
      ok(content.text.includes('# Predefined Account Tags Reference'), 'should contain title');
      ok(content.text.includes('Asset'), 'should contain Asset tag');
      ok(content.text.includes('Revenue'), 'should contain Revenue tag');
      ok(content.text.includes('Cash Flow - Cash Equivalents'), 'should contain cash flow tags');
      ok(content.text.includes('## Account Types'), 'should contain Account Types section');
      ok(content.text.includes('## Cash Flow Statement Tags'), 'should contain Cash Flow section');
      ok(content.text.includes('Total available tags: 42'), 'should show correct tag count');
    });

    it('provides account tags data resource', async function () {
      const res = await client.readResource({ uri: 'account-tags://data' });
      assertPropDefined(res, 'contents');
      assertArray(res.contents);
      ok(res.contents.length > 0, 'resource should have content');

      const content = res.contents[0] as { mimeType: string; text: string };
      ok(content.mimeType === 'application/json', 'should be JSON format');

      const data = JSON.parse(content.text);
      ok(data.accountTags, 'should have accountTags object');
      ok(data.allTags, 'should have allTags array');
      ok(data.totalCount === 42, 'should have exactly 42 tags');
      ok(Array.isArray(data.allTags), 'allTags should be an array');
      ok(data.allTags.includes('Asset'), 'should contain Asset tag');
      ok(data.allTags.includes('Revenue'), 'should contain Revenue tag');
      ok(data.allTags.includes('Cash Flow - Cash Equivalents'), 'should contain cash flow tags');
      ok(data.categories.includes('Account Types'), 'should include Account Types category');
      ok(data.categories.includes('Cash Flow Statement Tags'), 'should include Cash Flow category');
    });
  });
});
