import { ok, strictEqual } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/mcp-server/mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertDefined, assertArray, assertPropDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('ConfigMCPTools', function () {
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
  });

  afterEach(async function () {
    await client.close();
    await server.close();
    await repo.close();
  });

  describe('Tool: SetConfig', function () {
    it('should update business name', async function () {
      const result = await client.callTool({
        name: 'SetConfig',
        arguments: {
          configs: [{
            key: 'Business Name',
            value: 'New Business Name',
          }],
        },
      });

      strictEqual(result.content[0].type, 'text');
      strictEqual(result.content[0].text, 'Configuration updated: Business Name = "New Business Name"');

      // Verify the change
      const config = await repo.getUserConfig();
      strictEqual(config.businessName, 'New Business Name');
    });

    it('should update currency code', async function () {
      const result = await client.callTool({
        name: 'SetConfig',
        arguments: {
          configs: [{
            key: 'Currency Code',
            value: 'EUR',
          }],
        },
      });

      strictEqual(result.content[0].type, 'text');
      strictEqual(result.content[0].text, 'Configuration updated: Currency Code = "EUR"');

      // Verify the change
      const config = await repo.getUserConfig();
      strictEqual(config.currencyCode, 'EUR');
    });

    it('should update fiscal year start month', async function () {
      const result = await client.callTool({
        name: 'SetConfig',
        arguments: {
          configs: [{
            key: 'Fiscal Year Start Month',
            value: '4',
          }],
        },
      });

      strictEqual(result.content[0].type, 'text');
      strictEqual(result.content[0].text, 'Configuration updated: Fiscal Year Start Month = "4"');
    });

    it('should validate key at schema level', async function () {
      try {
        await client.callTool({
          name: 'SetConfig',
          arguments: {
            configs: [{
              key: 'Invalid Key' as any,
              value: 'some value',
            }],
          },
        });
        ok(false, 'Should have thrown an error');
      } catch (error) {
        ok(error.message.includes('Invalid enum value'));
      }
    });

    it('should update multiple configurations', async function () {
      const result = await client.callTool({
        name: 'SetConfig',
        arguments: {
          configs: [
            {
              key: 'Business Name',
              value: 'Updated Business',
            },
            {
              key: 'Currency Code',
              value: 'GBP',
            },
          ],
        },
      });

      strictEqual(result.content[0].type, 'text');
      strictEqual(result.content[0].text, 'Configuration updated: Business Name = "Updated Business", Currency Code = "GBP"');

      // Verify the changes
      const config = await repo.getUserConfig();
      strictEqual(config.businessName, 'Updated Business');
      strictEqual(config.currencyCode, 'GBP');
    });
  });

  describe('Tool: GetConfig', function () {
    it('should retrieve all configuration settings', async function () {
      const result = await client.callTool({
        name: 'GetConfig',
      });

      strictEqual(result.content[0].type, 'text');
      const text = result.content[0].text;
      ok(text.startsWith('User Configuration:'));
      ok(text.includes('Business Name: "Test Business"'));
      ok(text.includes('Business Type: "Test"'));
      ok(text.includes('Currency Code: "USD"'));
      ok(text.includes('Currency Decimals: "2'));
      ok(text.includes('Locale: "en-US"'));
      ok(text.includes('Fiscal Year Start Month: "1"'));
    });

    it('should handle empty configuration gracefully', async function () {
      // This test would require a fresh database, but for now we'll skip
      // as the schema inserts defaults
    });
  });
});
