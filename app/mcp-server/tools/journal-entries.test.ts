import { ok } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/mcp-server/mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertArray, assertPropDefined, assertDefined } from '@app/tools/assertion.js';
import { MemoryTransport } from '@app/mcp-server/mcp-server-test-utils.js';

suite('JournalEntriesMCPTools', function () {
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
      ok(responseText.includes('Draft journal entry created with ref'), 'should confirm creation');
      ok(responseText.includes('2024-01-01'), 'should include date');
      
      // Extract the reference number
      const refMatch = responseText.match(/ref (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef = parseInt(refMatch[1]);
      ok(entryRef > 0, 'Should have a valid reference number');
    });

    it('creates a draft journal entry with idempotentKey', async function () {
      const idempotentKey = 'test-key-' + Date.now();
      const res = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Test entry with idempotent key',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 200, amount: 1000, type: 'credit' },
          ],
          idempotentKey,
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Draft journal entry created with ref'), 'should confirm creation');
      
      // Extract the reference number
      const refMatch = responseText.match(/ref (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      const entryRef1 = parseInt(refMatch[1]);

      // Try to create the same entry again with the same idempotentKey
      const res2 = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Test entry with idempotent key',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 200, amount: 1000, type: 'credit' },
          ],
          idempotentKey,
        },
      });
      
      const responseText2 = (res2.content[0] as { text: string }).text;
      const refMatch2 = responseText2.match(/ref (\d+)/);
      assertDefined(refMatch2, 'Should extract journal entry reference');
      const entryRef2 = parseInt(refMatch2[1]);
      
      // Should return the same reference (idempotent behavior)
      ok(entryRef1 === entryRef2, `Should return same ref: ${entryRef1} === ${entryRef2}`);
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
      ok(responseText.includes('Draft journal entry created with ref'), 'should confirm creation');
    });
  });

  describe('Tool: updateJournalEntry', function () {
    let journalEntryRef: number;

    beforeEach(async function () {
      // Create a draft entry first
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Initial entry',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 200, amount: 500, type: 'credit' },
          ],
        },
      });
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/ref (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      journalEntryRef = parseInt(refMatch[1]);
    });

    it('updates an existing journal entry', async function () {
      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Updated entry',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 300, amount: 1000, type: 'credit' },
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Journal entry ${journalEntryRef} updated successfully`), 'should confirm update');
    });

    it('updates journal entry with idempotentKey', async function () {
      const idempotentKey = 'update-test-key-' + Date.now();
      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Updated entry with idempotent key',
          lines: [
            { accountCode: 100, amount: 1500, type: 'debit' },
            { accountCode: 300, amount: 1500, type: 'credit' },
          ],
          idempotentKey,
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Journal entry ${journalEntryRef} updated successfully`), 'should confirm update');
    });

    it('fails to update non-existent journal entry', async function () {
      const res = await client.callTool({
        name: 'updateJournalEntry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-02',
          description: 'Non-existent',
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
      ok(responseText.includes('Error updating journal entry'), 'should indicate error');
    });
  });

  describe('Tool: postJournalEntry', function () {
    let journalEntryRef: number;

    beforeEach(async function () {
      // Create a draft entry first
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Initial entry',
          lines: [
            { accountCode: 100, amount: 500, type: 'debit' },
            { accountCode: 200, amount: 500, type: 'credit' },
          ],
        },
      });
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/ref (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      journalEntryRef = parseInt(refMatch[1]);
    });

    it('posts a draft journal entry with default date', async function () {
      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Journal entry ${journalEntryRef} posted successfully`), 'should confirm posting');
    });

    it('posts a draft journal entry with specific date', async function () {
      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef, date: '2024-01-15' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Journal entry ${journalEntryRef} posted successfully`), 'should confirm posting');
    });

    it('fails to post non-existent entry', async function () {
      const res = await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef: 99999 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Error posting journal entry'), 'should indicate error');
    });
  });

  describe('Tool: deleteManyJournalEntryDrafts', function () {
    it('deletes multiple draft journal entries', async function () {
      // Create multiple draft entries
      const draft1Res = await client.callTool({
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
      const draft2Res = await client.callTool({
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

      const ref1Match = (draft1Res.content[0] as { text: string }).text.match(/ref (\d+)/);
      const ref2Match = (draft2Res.content[0] as { text: string }).text.match(/ref (\d+)/);
      assertDefined(ref1Match, 'Should extract first reference');
      assertDefined(ref2Match, 'Should extract second reference');
      const ref1 = parseInt(ref1Match[1]);
      const ref2 = parseInt(ref2Match[1]);

      const res = await client.callTool({
        name: 'deleteManyJournalEntryDrafts',
        arguments: { journalEntryRefs: [ref1, ref2] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes(`Draft journal entry ${ref1} deleted`), 'should confirm first deletion');
      ok(responseText.includes(`Draft journal entry ${ref2} deleted`), 'should confirm second deletion');
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
      ok(responseText.includes('No journal entry refs provided, nothing to delete'), 'should handle empty list');
    });
  });

  describe('Tool: reverseJournalEntry', function () {
    let journalEntryRef: number;

    beforeEach(async function () {
      // Create and post a journal entry first
      const draftRes = await client.callTool({
        name: 'draftJournalEntry',
        arguments: {
          date: '2024-01-01',
          description: 'Original entry',
          lines: [
            { accountCode: 100, amount: 1000, type: 'debit' },
            { accountCode: 200, amount: 1000, type: 'credit' },
          ],
        },
      });
      const draftText = (draftRes.content[0] as { text: string }).text;
      const refMatch = draftText.match(/ref (\d+)/);
      assertDefined(refMatch, 'Should extract journal entry reference');
      journalEntryRef = parseInt(refMatch[1]);
      
      // Post the entry
      await client.callTool({
        name: 'postJournalEntry',
        arguments: { journalEntryRef },
      });
    });

    it('reverses a posted journal entry', async function () {
      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Reversal of original entry',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Reversal journal entry created with ref'), 'should confirm reversal creation');
      ok(responseText.includes(`for original entry ${journalEntryRef}`), 'should reference original entry');
    });

    it('reverses a posted journal entry with idempotentKey', async function () {
      const idempotentKey = 'reversal-test-key-' + Date.now();
      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Reversal with idempotent key',
          idempotentKey,
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Reversal journal entry created with ref'), 'should confirm reversal creation');
      
      // Extract the reversal reference number
      const refMatch = responseText.match(/created with ref (\d+)/);
      assertDefined(refMatch, 'Should extract reversal reference');
      const reversalRef1 = parseInt(refMatch[1]);

      // Try to create the same reversal again with the same idempotentKey
      const res2 = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef,
          date: '2024-01-02',
          description: 'Reversal with idempotent key',
          idempotentKey,
        },
      });
      
      const responseText2 = (res2.content[0] as { text: string }).text;
      const refMatch2 = responseText2.match(/created with ref (\d+)/);
      assertDefined(refMatch2, 'Should extract reversal reference');
      const reversalRef2 = parseInt(refMatch2[1]);
      
      // Should return the same reference (idempotent behavior)
      ok(reversalRef1 === reversalRef2, `Should return same reversal ref: ${reversalRef1} === ${reversalRef2}`);
    });

    it('fails to reverse non-existent entry', async function () {
      const res = await client.callTool({
        name: 'reverseJournalEntry',
        arguments: {
          journalEntryRef: 99999,
          date: '2024-01-02',
          description: 'Reversal of non-existent',
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
      
      const responseText = (res.content[0] as { text: string }).text;
      ok(responseText.includes('Error reversing journal entry'), 'should indicate error');
    });
  });
});
