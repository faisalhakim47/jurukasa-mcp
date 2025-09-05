import { ok } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/accounting-mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertArray, assertPropDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('SqlExecutionMCPTool', function () {
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

  describe('Tool: executeSqlQuery', function () {
    it('executes a SELECT query and returns results', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT code, name, normal_balance FROM account ORDER BY code',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should confirm execution');
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include Cash account');
      ok(responseText.includes('200') && responseText.includes('Revenue'), 'should include Revenue account');
      ok(responseText.includes('300') && responseText.includes('Equity'), 'should include Equity account');
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
      ok(responseText.includes('Query executed successfully'), 'should confirm execution');
      ok(responseText.includes('100') && responseText.includes('Cash'), 'should include only Cash account');
      ok(!responseText.includes('200') && !responseText.includes('300'), 'should not include other accounts');
    });

    it('handles query with no results', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT * FROM account WHERE code = 999',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully, but returned no results'), 'should handle no results');
    });

    it('handles invalid SQL query', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT invalid_column FROM nonexistent_table',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Error executing SQL query'), 'should handle SQL errors');
    });

    it('executes a COUNT query', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT COUNT(*) as account_count FROM account',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should confirm execution');
      ok(responseText.includes('account_count'), 'should include count column');
      ok(responseText.includes('3'), 'should show count of 3 accounts');
    });

    it('executes a query with JOIN', async function () {
      // First set up some tags
      await client.callTool({
        name: 'setManyAccountTags',
        arguments: {
          taggedAccounts: [
            { code: 100, tag: 'Asset' },
            { code: 200, tag: 'Revenue' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: `
            SELECT a.code, a.name, at.tag 
            FROM account a 
            LEFT JOIN account_tag at ON a.code = at.account_code 
            ORDER BY a.code
          `,
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should confirm execution');
      ok(responseText.includes('100') && responseText.includes('Asset'), 'should show Asset tag for account 100');
      ok(responseText.includes('200') && responseText.includes('Revenue'), 'should show Revenue tag for account 200');
    });

    it('executes query with various parameter types', async function () {
      const res = await client.callTool({
        name: 'executeSqlQuery',
        arguments: {
          query: 'SELECT ? as string_param, ? as number_param, ? as boolean_param, ? as null_param',
          params: ['test string', 42, true, null],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Query executed successfully'), 'should confirm execution');
      ok(responseText.includes('test string'), 'should handle string parameter');
      ok(responseText.includes('42'), 'should handle number parameter');
      ok(responseText.includes('1') || responseText.includes('true'), 'should handle boolean parameter');
    });
  });
});
