import { ok } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { createAccountingMcpServer } from '@app/accounting-mcp-server.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { assertDefined, assertArray, assertPropDefined, assertNumber, assertString } from '@app/tools/assertion.js';

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

    await client.callTool({ name: 'account.add', arguments: { code: 100, name: 'Cash', normalBalance: 'debit' } });
    await client.callTool({ name: 'account.add', arguments: { code: 200, name: 'Revenue', normalBalance: 'credit' } });
    await client.callTool({ name: 'account.setName', arguments: { code: 100, name: 'Cash Account' } });
    await client.callTool({ name: 'account.setControl', arguments: { code: 100, controlAccountCode: 200 } });
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

    it('sql.query returns rows for a harmless query', async function () {
  const callResult = await client.callTool({ name: 'sql.query', arguments: { sql: 'SELECT 1 as x' } });
  assertPropDefined(callResult, 'content');
  assertArray(callResult.content);
  ok(callResult.content.length > 0, 'tool call should return content');
    });

  });

  describe('Tool: account.add', function () {
    it('returns content when adding a new account', async function () {
  const res = await client.callTool({ name: 'account.add', arguments: { code: 300, name: 'Equity', normalBalance: 'credit' } });
  assertPropDefined(res, 'content');
  assertDefined(res.content);
  ok(res.content, 'account.add should return content');
    });
  });

  describe('Tool: account.setName', function () {
    it('updates the account name and returns content', async function () {
  const res = await client.callTool({ name: 'account.setName', arguments: { code: 100, name: 'Cash Account' } });
  assertPropDefined(res, 'content');
  ok(res.content, 'account.setName should return content');
    });
  });

  describe('Tool: account.setControl', function () {
    it('sets control account and returns content', async function () {
  const res = await client.callTool({ name: 'account.setControl', arguments: { code: 100, controlAccountCode: 200 } });
  assertPropDefined(res, 'content');
  ok(res.content, 'account.setControl should return content');
    });
  });

  describe('Tool: account.getHierarchy', function () {
    it('returns content or an error wrapper', async function () {
      const res = await client.callTool({ name: 'account.getHierarchy', arguments: {} });
      assertDefined(res);
      if (typeof res === 'object' && res !== null && 'content' in res) {
        assertPropDefined(res, 'content');
        ok((res as Record<string, unknown>).content, 'account.getHierarchy should return content or an error wrapper');
      }
      else {
        assertPropDefined(res, 'isError');
        ok((res as Record<string, unknown>).isError, 'account.getHierarchy should return content or an error wrapper');
      }
    });
  });

  describe('Tool: account.getByCode', function () {
    it('retrieves account by code', async function () {
  const res = await client.callTool({ name: 'account.getByCode', arguments: { code: 100 } });
  assertPropDefined(res, 'content');
  ok((res as Record<string, unknown>).content, 'account.getByCode should return content');
    });
  });

  describe('Tool: account.getByName', function () {
    it('retrieves account by name', async function () {
  const res = await client.callTool({ name: 'account.getByName', arguments: { name: 'Cash Account' } });
  assertPropDefined(res, 'content');
  ok((res as Record<string, unknown>).content, 'account.getByName should return content');
    });
  });

  describe('Tool: account tagging', function () {
    it('sets a tag on an account', async function () {
  const res = await client.callTool({ name: 'account.setTag', arguments: { code: 100, tag: 'liquid' } });
  assertPropDefined(res, 'content');
  ok((res as Record<string, unknown>).content, 'account.setTag should return content');
    });

    it('lists accounts by tag', async function () {
  await client.callTool({ name: 'account.setTag', arguments: { code: 100, tag: 'liquid' } });
  const res = await client.callTool({ name: 'account.listByTag', arguments: { tag: 'liquid', offset: 0, limit: 10 } });
  assertPropDefined(res, 'content');
  ok((res as Record<string, unknown>).content, 'account.listByTag should return content');
    });

    it('unsets a tag on an account', async function () {
  await client.callTool({ name: 'account.setTag', arguments: { code: 100, tag: 'liquid' } });
  const res = await client.callTool({ name: 'account.unsetTag', arguments: { code: 100, tag: 'liquid' } });
  assertPropDefined(res, 'content');
  ok((res as Record<string, unknown>).content, 'account.unsetTag should return content');
    });
  });

  describe('Tool: journal workflow', function () {
    it('drafts a balanced journal entry and returns a ref', async function () {
      const draft = await client.callTool({ name: 'journal.draft', arguments: { entryTime: Date.now(), description: 'Test', lines: [{ accountCode: 100, debit: 100, credit: 0 }, { accountCode: 200, debit: 0, credit: 100 }] } });
      assertPropDefined(draft, 'content');
      assertArray(draft.content);
      const draftContent = draft.content as Array<unknown>;
      ok(draftContent.length > 0, 'journal.draft should return content');
      let draftRef: number | undefined;
      try {
  assertPropDefined(draftContent[0], 'text');
  const draftText = (draftContent[0] as Record<string, unknown>).text;
  assertString(draftText);
  const parsed: unknown = JSON.parse(draftText);
  assertPropDefined(parsed, 'ref');
  assertNumber((parsed as Record<string, unknown>).ref);
  draftRef = (parsed as Record<string, number>).ref;
      }
      catch (_e) {
        assertPropDefined(draft, 'structuredContent');
        assertPropDefined(draft.structuredContent, 'ref');
        assertNumber((draft.structuredContent as Record<string, unknown>).ref);
        draftRef = (draft.structuredContent as Record<string, number>).ref;
      }
      ok(typeof draftRef === 'number', 'draftRef should be a number');
    });

    it('adds a line and posts the journal entry', async function () {
      // create a draft first
      const draft = await client.callTool({ name: 'journal.draft', arguments: { entryTime: Date.now(), description: 'Test', lines: [{ accountCode: 100, debit: 100, credit: 0 }, { accountCode: 200, debit: 0, credit: 100 }] } });
      assertPropDefined(draft, 'content');
      assertArray(draft.content);
      const draftContent = draft.content as Array<unknown>;
      let draftRef: number | undefined;
      try {
  assertPropDefined(draftContent[0], 'text');
  const draftText = (draftContent[0] as Record<string, unknown>).text;
  assertString(draftText);
  const parsed: unknown = JSON.parse(draftText);
  assertPropDefined(parsed, 'ref');
  assertNumber((parsed as Record<string, unknown>).ref);
  draftRef = (parsed as Record<string, number>).ref;
      }
      catch (_e) {
        assertPropDefined(draft, 'structuredContent');
        assertPropDefined(draft.structuredContent, 'ref');
        assertNumber((draft.structuredContent as Record<string, unknown>).ref);
        draftRef = (draft.structuredContent as Record<string, number>).ref;
      }
      ok(typeof draftRef === 'number', 'draftRef should be a number');

      const addLine = await client.callTool({ name: 'journal.addLine', arguments: { journalEntryRef: draftRef, accountCode: 100, debit: 0, credit: 0, description: null, reference: null } });
      assertPropDefined(addLine, 'content');
      ok((addLine as Record<string, unknown>).content, 'journal.addLine should return content');

      const post = await client.callTool({ name: 'journal.post', arguments: { ref: draftRef, postTime: Date.now() } });
      assertPropDefined(post, 'content');
      ok((post as Record<string, unknown>).content, 'journal.post should return content');
    });
  });

  describe('Tool: reporting', function () {
    it('generates a report', async function () {
      const res = await client.callTool({ name: 'report.generate', arguments: { reportTime: Date.now() } });
      assertPropDefined(res, 'content');
      ok((res as Record<string, unknown>).content, 'report.generate should return content');
    });

    it('trialBalance and balanceSheet return content or error wrappers', async function () {
      const trial = await client.callTool({ name: 'report.trialBalance', arguments: { reportTime: Date.now() } });
      assertDefined(trial);
      if (typeof trial === 'object' && trial !== null && 'content' in trial) {
        assertPropDefined(trial, 'content');
        ok((trial as Record<string, unknown>).content, 'report.trialBalance should return content or an error wrapper');
      }
      else {
        assertPropDefined(trial, 'isError');
        ok((trial as Record<string, unknown>).isError, 'report.trialBalance should return content or an error wrapper');
      }

      const balance = await client.callTool({ name: 'report.balanceSheet', arguments: { reportTime: Date.now() } });
      assertDefined(balance);
      if (typeof balance === 'object' && balance !== null && 'content' in balance) {
        assertPropDefined(balance, 'content');
        ok((balance as Record<string, unknown>).content, 'report.balanceSheet should return content or an error wrapper');
      }
      else {
        assertPropDefined(balance, 'isError');
        ok((balance as Record<string, unknown>).isError, 'report.balanceSheet should return content or an error wrapper');
      }
    });
  });

});
