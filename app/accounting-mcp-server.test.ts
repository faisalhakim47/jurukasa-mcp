import { ok } from 'node:assert/strict';
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
            { code: 300, name: 'Equity', normalBalance: 'credit' }, // new
          ],
        },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });

    it('handles empty accounts list', async function () {
      const res = await client.callTool({
        name: 'ensure_many_accounts_exist',
        arguments: { accounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
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
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'rename_account',
        arguments: { code: 999, name: 'Nonexistent' },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
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
    });

    it('fails for non-existing account', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 999, controlAccountCode: 200 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });

    it('fails for non-existing control account', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 999 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });

    it('fails if account is its own control', async function () {
      const res = await client.callTool({
        name: 'set_control_account',
        arguments: { accountCode: 100, controlAccountCode: 100 },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
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
    });

    it('retrieves accounts by names', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { names: ['Cash'] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });

    it('returns no accounts for no matches', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: { codes: [999] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });

    it('fails with no filters', async function () {
      const res = await client.callTool({
        name: 'get_many_accounts',
        arguments: {},
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
    });
  });

  describe('Tool: set_many_account_tags', function () {
    it('sets tags for multiple accounts', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
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
    });

    it('handles empty tagged accounts list', async function () {
      const res = await client.callTool({
        name: 'set_many_account_tags',
        arguments: { taggedAccounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
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
    });

    it('handles empty tagged accounts list', async function () {
      const res = await client.callTool({
        name: 'unset_many_account_tags',
        arguments: { taggedAccounts: [] },
      });
      assertPropDefined(res, 'content');
      assertArray(res.content);
      ok(res.content.length > 0, 'tool should return content');
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

      // Extract journal entry ref from response (assuming it's in the text)
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
    });
  });
});
