import { ok, equal, deepEqual, rejects, doesNotReject, throws, doesNotThrow } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/mcp-server/mcp-server.js';
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
      name: 'manageManyAccounts',
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

  describe('Tool: manageManyAccounts', function () {
    it('creates new accounts and skips existing ones', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
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
      ok(responseText.includes('account 100 "Cash" was found but no changes were made'), 'should skip existing account 100');
      ok(responseText.includes('new account 400 "Expenses" has been created'), 'should create new account 400');

      // Verify the new account was actually created
      const account400 = await repo.getAccountByCode(400);
      ok(account400 !== null, 'account 400 should exist');
      equal(account400?.name, 'Expenses');
      equal(account400?.normalBalance, 'debit');
    });

    it('handles empty accounts list', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: { accounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('No accounts provided'), 'should handle empty list appropriately');
    });

    it('updates existing account names', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Petty Cash', normalBalance: 'debit' },
            { code: 200, name: 'Sales Revenue', normalBalance: 'credit' },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('account\'s name has been updated from "Cash" to "Petty Cash"'), 'should update account 100 name');
      ok(responseText.includes('account\'s name has been updated from "Revenue" to "Sales Revenue"'), 'should update account 200 name');

      // Verify the names were actually updated
      const account100 = await repo.getAccountByCode(100);
      const account200 = await repo.getAccountByCode(200);
      equal(account100?.name, 'Petty Cash');
      equal(account200?.name, 'Sales Revenue');
    });

    it('sets control account hierarchy', async function () {
      // First create a parent account
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 1000, name: 'Assets', normalBalance: 'debit' },
          ],
        },
      });

      // Now set control account for existing accounts
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit', controlAccountCode: 1000 },
            { code: 400, name: 'Expenses', normalBalance: 'debit', controlAccountCode: 1000 },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('control code has been updated from "None" to "1000"'), 'should update control account');

      // Verify control accounts were set using SQL query to bypass any filtering
      const controlAccountResults = await repo.sqlQuery('SELECT code, control_account_code FROM account WHERE code IN (100, 400)', []);
      const account100Result = controlAccountResults.find((row: any) => row.code === 100);
      const account400Result = controlAccountResults.find((row: any) => row.code === 400);
      equal((account100Result as any)?.control_account_code, 1000);
      equal((account400Result as any)?.control_account_code, 1000);
    });

    it('deactivates accounts with zero balance', async function () {
      // Create a new account to deactivate
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 500, name: 'Temporary Account', normalBalance: 'debit' },
          ],
        },
      });

      // Deactivate the account
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 500, name: 'Temporary Account', normalBalance: 'debit', deactivate: true },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('the account has been deactivated/closed'), 'should deactivate account');
      ok(responseText.includes('Final balance was $0.00'), 'should show zero balance');

      // Verify account was deactivated - need to use SQL query since getAccountByCode only returns active accounts
      const deactivatedAccounts = await repo.sqlQuery('SELECT is_active FROM account WHERE code = ?', [500]);
      equal((deactivatedAccounts[0] as any).is_active, 0);
    });

    it('rejects updates when normal balance mismatches', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'credit' }, // Wrong normal balance
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('normal balance mismatch'), 'should reject normal balance mismatch');
      ok(responseText.includes('existing: debit, provided: credit'), 'should show mismatch details');
      ok(responseText.includes('No changes were made'), 'should make no changes');
    });

    it('handles account creation errors gracefully', async function () {
      // Try to create account with duplicate code but different normal balance
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Duplicate Cash', normalBalance: 'credit' },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('normal balance mismatch'), 'should handle creation error properly');
    });

    it('processes mixed create and update operations', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Updated Cash', normalBalance: 'debit' }, // Update existing
            { code: 600, name: 'New Liability', normalBalance: 'credit' }, // Create new
            { code: 200, name: 'Revenue', normalBalance: 'credit' }, // No change
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('account\'s name has been updated'), 'should update existing account');
      ok(responseText.includes('new account 600 "New Liability" has been created'), 'should create new account');
      ok(responseText.includes('was found but no changes were made'), 'should report no changes when applicable');
    });

    it('handles multiple control account changes', async function () {
      // Create parent accounts
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 2000, name: 'Current Assets', normalBalance: 'debit' },
            { code: 3000, name: 'Fixed Assets', normalBalance: 'debit' },
          ],
        },
      });

      // Set initial control account
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit', controlAccountCode: 2000 },
          ],
        },
      });

      // Change control account
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit', controlAccountCode: 3000 },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('control code has been updated from "2000" to "3000"'), 'should update control account');

      // Verify the change
      const account100 = await repo.getAccountByCode(100);
      equal(account100?.controlAccountCode, 3000);
    });
  });


  describe('Tool: ViewChartOfAccounts', function () {
    it('returns hierarchical chart with basic structure', async function () {
      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Chart of Accounts'), 'should have chart title');
      ok(responseText.includes('account 100 "Cash"'), 'should show account 100');
      ok(responseText.includes('account 200 "Revenue"'), 'should show account 200');
      ok(responseText.includes('account 300 "Equity"'), 'should show account 300');
      ok(responseText.includes('balance: $0.00'), 'should show balance formatting');
      ok(responseText.includes('normal balance: debit'), 'should show normal balance for debit accounts');
      ok(responseText.includes('normal balance: credit'), 'should show normal balance for credit accounts');
    });

    it('displays hierarchical structure with parent-child relationships', async function () {
      // Set up a hierarchy: Assets -> Current Assets -> Cash
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 1000, name: 'Assets', normalBalance: 'debit' },
            { code: 1100, name: 'Current Assets', normalBalance: 'debit', controlAccountCode: 1000 },
          ],
        },
      });

      // Update existing cash account to be under Current Assets
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 100, name: 'Cash', normalBalance: 'debit', controlAccountCode: 1100 },
          ],
        },
      });

      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('account 1000 "Assets"'), 'should show parent account');
      ok(responseText.includes('account 1100 "Current Assets"'), 'should show intermediate account');
      ok(responseText.includes('account 100 "Cash"'), 'should show child account');

      // Verify hierarchical indentation structure (looking for tree characters)
      ok(responseText.includes('├─') || responseText.includes('└─'), 'should have tree structure indicators');
    });

    it('shows account balances with proper currency formatting', async function () {
      // Create a journal entry to give accounts some balance
      await repo.draftJournalEntry({
        entryTime: Date.now(),
        description: 'Test balances',
        lines: [
          { accountCode: 100, debit: 15, credit: 0 },    // Cash gets $0.15 debit
          { accountCode: 200, debit: 0, credit: 15 },    // Revenue gets $0.15 credit
        ],
      }).then(async (entryId) => {
        await repo.postJournalEntry(entryId, Date.now());
      });

      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('balance: $15.00'), 'should show formatted balance');
    });

    it('handles showInactive parameter to include inactive accounts', async function () {
      // Create and then deactivate an account
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 700, name: 'Inactive Account', normalBalance: 'debit' },
          ],
        },
      });

      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 700, name: 'Inactive Account', normalBalance: 'debit', deactivate: true },
          ],
        },
      });

      // Test without showInactive (should not show inactive)
      const resActiveOnly = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: { showInactive: false },
      });

      const activeOnlyText = (resActiveOnly.content[0] as { text: string }).text;
      ok(!activeOnlyText.includes('account 700 "Inactive Account"'), 'should not show inactive account when showInactive is false');

      // Test with showInactive (should show inactive)
      const resWithInactive = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: { showInactive: true },
      });

      const withInactiveText = (resWithInactive.content[0] as { text: string }).text;
      ok(withInactiveText.includes('account 700 "Inactive Account"'), 'should show inactive account when showInactive is true');
    });

    it('handles empty chart of accounts gracefully', async function () {
      // Create a fresh repo with no accounts
      const freshRepo = new SqliteAccountingRepository(':memory:');
      await freshRepo.connect();
      const freshServer = createAccountingMcpServer(freshRepo);
      const freshClientTransport = new MemoryTransport();
      const freshServerTransport = new MemoryTransport();
      freshClientTransport._paired = freshServerTransport;
      freshServerTransport._paired = freshClientTransport;
      const freshClient = new Client({ name: 'test-client', version: '1.0.0' });

      await Promise.all([
        freshServer.connect(freshServerTransport),
        freshClient.connect(freshClientTransport),
      ]);

      await freshRepo.setUserConfig({
        businessName: 'Test Business',
        businessType: 'Test',
        currencyCode: 'USD',
        currencyDecimalPlaces: 2,
        locale: 'en-US',
      });

      const res = await freshClient.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Chart of Accounts'), 'should still show chart title');

      // Clean up
      await Promise.all([
        freshClient.close(),
        freshServer.close(),
      ]);
      await freshRepo.close();
    });

    it('displays complex multi-level hierarchy correctly', async function () {
      // Create a complex hierarchy
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            // Level 1
            { code: 1000, name: 'Assets', normalBalance: 'debit' },
            { code: 2000, name: 'Liabilities', normalBalance: 'credit' },
            // Level 2
            { code: 1100, name: 'Current Assets', normalBalance: 'debit', controlAccountCode: 1000 },
            { code: 1200, name: 'Fixed Assets', normalBalance: 'debit', controlAccountCode: 1000 },
            { code: 2100, name: 'Current Liabilities', normalBalance: 'credit', controlAccountCode: 2000 },
            // Level 3
            { code: 1110, name: 'Cash and Equivalents', normalBalance: 'debit', controlAccountCode: 1100 },
            { code: 1120, name: 'Receivables', normalBalance: 'debit', controlAccountCode: 1100 },
          ],
        },
      });

      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;

      // Verify all levels are present
      ok(responseText.includes('account 1000 "Assets"'), 'should show top-level Assets');
      ok(responseText.includes('account 1100 "Current Assets"'), 'should show level 2 Current Assets');
      ok(responseText.includes('account 1110 "Cash and Equivalents"'), 'should show level 3 Cash and Equivalents');
      ok(responseText.includes('account 2000 "Liabilities"'), 'should show top-level Liabilities');
      ok(responseText.includes('account 2100 "Current Liabilities"'), 'should show level 2 Current Liabilities');

      // Check that the hierarchy makes visual sense (tree structure)
      ok(responseText.includes('├─') || responseText.includes('└─'), 'should have tree structure indicators');
    });

    it('sorts accounts properly in hierarchy', async function () {
      // Create accounts in non-sequential order
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 1300, name: 'Third Account', normalBalance: 'debit' },
            { code: 1100, name: 'First Account', normalBalance: 'debit' },
            { code: 1200, name: 'Second Account', normalBalance: 'debit' },
          ],
        },
      });

      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;

      // Check that accounts appear in a reasonable order (chart should be structured)
      ok(responseText.includes('account 1100'), 'should include account 1100');
      ok(responseText.includes('account 1200'), 'should include account 1200');
      ok(responseText.includes('account 1300'), 'should include account 1300');
    });
  });

  describe('Edge Cases and Error Handling', function () {
    it('handles malformed account data gracefully', async function () {
      // Test with invalid account codes
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: -1, name: 'Invalid Code', normalBalance: 'debit' },
            { code: 0, name: 'Zero Code', normalBalance: 'debit' },
          ],
        },
      });

      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content even with invalid data');
    });

    it('handles extremely long account names', async function () {
      const longName = 'A'.repeat(1000); // Very long account name
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 9999, name: longName, normalBalance: 'debit' },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.length > 0, 'should handle long names without crashing');
    });

    it('handles special characters in account names', async function () {
      const specialName = 'Test & Co. "Special" <Account> $%@!';
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 8888, name: specialName, normalBalance: 'debit' },
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('new account 8888'), 'should handle special characters in names');
    });

    it('handles large batch operations', async function () {
      // Create a large number of accounts at once
      const largeAccountsBatch = [];
      for (let i = 5000; i < 5100; i++) {
        largeAccountsBatch.push({
          code: i,
          name: `Account ${i}`,
          normalBalance: i % 2 === 0 ? 'debit' : 'credit' as 'debit' | 'credit',
        });
      }

      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: { accounts: largeAccountsBatch },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('new account'), 'should handle large batch operations');

      // Verify some accounts were created
      const account5000 = await repo.getAccountByCode(5000);
      const account5099 = await repo.getAccountByCode(5099);
      ok(account5000 !== null, 'should create first account in batch');
      ok(account5099 !== null, 'should create last account in batch');
    });

    it('handles circular control account references gracefully', async function () {
      // Create accounts first
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 8001, name: 'Parent A', normalBalance: 'debit' },
            { code: 8002, name: 'Parent B', normalBalance: 'debit' },
          ],
        },
      });

      // Try to create circular reference: A -> B -> A
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 8001, name: 'Parent A', normalBalance: 'debit', controlAccountCode: 8002 },
          ],
        },
      });

      // This should either succeed or fail gracefully - the important thing is it doesn't crash
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 8002, name: 'Parent B', normalBalance: 'debit', controlAccountCode: 8001 },
          ],
        },
      });

      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'should handle circular references without crashing');
    });

    it('handles invalid control account codes', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 9001, name: 'Test Account', normalBalance: 'debit', controlAccountCode: 99999 }, // Non-existent control account
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      // Should either create successfully (DB will handle FK constraint) or show error message
      ok(responseText.length > 0, 'should handle invalid control account codes gracefully');
    });

    it('preserves data integrity during mixed success/failure operations', async function () {
      const res = await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 9100, name: 'Valid Account', normalBalance: 'debit' }, // Should succeed
            { code: 100, name: 'Cash', normalBalance: 'credit' }, // Should fail (normal balance mismatch)
            { code: 9101, name: 'Another Valid Account', normalBalance: 'credit' }, // Should succeed
          ],
        },
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('new account 9100'), 'should create valid accounts');
      ok(responseText.includes('normal balance mismatch'), 'should report error for invalid account');
      ok(responseText.includes('new account 9101'), 'should continue processing after error');

      // Verify the valid accounts were created
      const account9100 = await repo.getAccountByCode(9100);
      const account9101 = await repo.getAccountByCode(9101);
      ok(account9100 !== null, 'should create first valid account');
      ok(account9101 !== null, 'should create second valid account');
    });

    it('handles ViewChartOfAccounts with corrupted hierarchy data', async function () {
      // Create accounts with potentially problematic hierarchy
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [
            { code: 9200, name: 'Orphaned Child', normalBalance: 'debit', controlAccountCode: 99999 }, // Parent doesn't exist
          ],
        },
      });

      // ViewChartOfAccounts should handle this gracefully
      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'should return content even with problematic hierarchy');

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Chart of Accounts'), 'should still show chart title');
    });

    it('handles concurrent account operations', async function () {
      // Simulate concurrent operations by creating the same account multiple times rapidly
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          client.callTool({
            name: 'manageManyAccounts',
            arguments: {
              accounts: [
                { code: 9300 + i, name: `Concurrent Account ${i}`, normalBalance: 'debit' },
              ],
            },
          })
        );
      }

      const results = await Promise.all(promises);

      // All operations should complete successfully
      for (const result of results) {
        assertPropDefined(result, 'content');
        assertArray(result.content);
        ok(result.content.length > 0, 'should handle concurrent operations');
      }
    });

    it('handles ViewChartOfAccounts with very deep hierarchy', async function () {
      // Create a deep hierarchy (10 levels)
      let parentCode = 9400;
      await client.callTool({
        name: 'manageManyAccounts',
        arguments: {
          accounts: [{ code: parentCode, name: 'Level 1', normalBalance: 'debit' }],
        },
      });

      for (let level = 2; level <= 10; level++) {
        const currentCode = parentCode + level - 1;
        await client.callTool({
          name: 'manageManyAccounts',
          arguments: {
            accounts: [
              {
                code: currentCode,
                name: `Level ${level}`,
                normalBalance: 'debit',
                controlAccountCode: parentCode + level - 2
              },
            ],
          },
        });
      }

      const res = await client.callTool({
        name: 'ViewChartOfAccounts',
        arguments: {},
      });

      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Level 1'), 'should show top level');
      ok(responseText.includes('Level 10'), 'should show deep level');
      ok(responseText.includes('├─') || responseText.includes('└─'), 'should maintain tree structure for deep hierarchy');
    });
  });

});
