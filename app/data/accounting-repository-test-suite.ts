import { equal, strictEqual } from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, suite } from 'node:test';

import { AccountingRepository } from '@app/data/accounting-repository.js';
import { assertDefined } from '@app/tools/assertion.js';

export async function runAccountingRepositoryTestSuite(
  createRepository: () => Promise<AccountingRepository>,
  closeRepository: (accountingRepository: AccountingRepository) => Promise<void>,
): Promise<void> {
  suite('AccountingRepository', function () {
    let repo: AccountingRepository;

    beforeEach(async function (t) {
      repo = await createRepository();
    });

    afterEach(async function (t) {
      await closeRepository(repo);
    });

    describe('addAccount', function () {

      it('should add an account successfully', async function () {
        await repo.addAccount(1000, 'Cash', 'debit');
        const addedAccount = await repo.getAccountByCode(1000);
        assertDefined(addedAccount);
        equal(addedAccount.code, 1000);
        equal(addedAccount.name, 'Cash');
        equal(addedAccount.normalBalance, 'debit');
      });

    });

    describe('account updates and tagging', function () {
      it('should update account name and control account', async function () {
        await repo.addAccount(1100, 'Old Name', 'debit');
        await repo.addAccount(1200, 'Parent Account', 'debit');
        await repo.setAccountName(1100, 'New Name');
        await repo.setControlAccount(1100, 1200);

        const a = await repo.getAccountByCode(1100);
        strictEqual(a?.name, 'New Name');

        // verify control account via raw SQL helper
        const rows = await repo.sqlQuery('SELECT control_account_code as c FROM account WHERE code = ?', [1100]);
        strictEqual((rows[0] as any).c, 1200);
      });

      it('should set and unset tags and query by tag', async function () {
        await repo.addAccount(1300, 'Tagged Account', 'debit');
        // ensure no accounts returned for a non-existent tag
        const empty = await repo.getAccountsByTag('Some Tag', 0, 10);
        strictEqual(empty.length, 0);

        await repo.setAccountTag(1300, 'Asset');
        const tagged = await repo.getAccountsByTag('Asset', 0, 10);
        strictEqual(tagged.length, 1);
        strictEqual(tagged[0].code, 1300);

        await repo.unsetAccountTag(1300, 'Asset');
        const afterUnset = await repo.getAccountsByTag('Asset', 0, 10);
        strictEqual(afterUnset.length, 0);
      });
    });

    describe('journal entries, posting and reporting', function () {
      it('should draft, post journal entry and update balances', async function () {
        // create two accounts: debit-normal and credit-normal
        await repo.addAccount(2000, 'Cash A', 'debit');
        await repo.addAccount(3000, 'Revenue B', 'credit');

        const now = Date.now();
        const entryId = await repo.draftJournalEntry({
          entryTime: now,
          description: 'Test entry',
          lines: [
            { accountCode: 2000, debit: 100, credit: 0 },
            { accountCode: 3000, debit: 0, credit: 100 },
          ],
        });

        // balances should still be zero before posting
        const beforeA = await repo.getAccountByCode(2000);
        const beforeB = await repo.getAccountByCode(3000);
        strictEqual(beforeA?.balance, 0);
        strictEqual(beforeB?.balance, 0);

        await repo.postJournalEntry(entryId, now);

        const a = await repo.getAccountByCode(2000);
        const b = await repo.getAccountByCode(3000);
        strictEqual(a?.normalBalance, 'debit');
        strictEqual(b?.normalBalance, 'credit');
        strictEqual(a?.balance, 100);
        strictEqual(b?.balance, 100);
      });

      it('should update journal entry before posting', async function () {
        // create accounts
        await repo.addAccount(2100, 'Cash C', 'debit');
        await repo.addAccount(3100, 'Revenue C', 'credit');
        await repo.addAccount(2200, 'Bank D', 'debit');

        const originalTime = Date.now() - 1000;
        const updatedTime = Date.now();

        // draft initial entry
        const entryId = await repo.draftJournalEntry({
          entryTime: originalTime,
          description: 'Original entry',
          lines: [
            { accountCode: 2100, debit: 50, credit: 0 },
            { accountCode: 3100, debit: 0, credit: 50 },
          ],
        });

        // update the entry with new time, description and lines
        await repo.updateJournalEntry(entryId, {
          entryTime: updatedTime,
          description: 'Updated entry',
          lines: [
            { accountCode: 2200, debit: 75, credit: 0 },
            { accountCode: 3100, debit: 0, credit: 75 },
          ],
        });

        // post the updated entry
        await repo.postJournalEntry(entryId, updatedTime);

        // verify the accounts have the updated amounts
        const cashC = await repo.getAccountByCode(2100);
        const bankD = await repo.getAccountByCode(2200);
        const revenueC = await repo.getAccountByCode(3100);

        strictEqual(cashC?.balance, 0); // should be 0, not affected by updated entry
        strictEqual(bankD?.balance, 75); // should have the updated amount
        strictEqual(revenueC?.balance, 75); // should have the updated amount

        // verify the journal entry details via raw SQL
        const entryRows = await repo.sqlQuery('SELECT entry_time, note FROM journal_entry WHERE ref = ?', [entryId]);
        strictEqual(entryRows.length, 1);
        const entry = entryRows[0] as any;
        strictEqual(entry.entry_time, updatedTime);
        strictEqual(entry.note, 'Updated entry');
      });

      it('should generate trial balance and balance sheet reports', async function () {
        const reportTime = Date.now();

        // create accounts and a balancing journal entry so balances are non-zero
        await repo.addAccount(2000, 'Cash A', 'debit');
        await repo.addAccount(3000, 'Revenue B', 'credit');

        await repo.setAccountTag(2000, 'Balance Sheet - Current Asset');
        await repo.setAccountTag(3000, 'Balance Sheet - Equity');

        const now = Date.now();
        const entryId = await repo.draftJournalEntry({
          entryTime: now,
          description: 'Populate balances',
          lines: [
            { accountCode: 2000, debit: 75, credit: 0 },
            { accountCode: 3000, debit: 0, credit: 75 },
          ],
        });
        await repo.postJournalEntry(entryId, now);

        const reportId = await repo.generateFinancialReport(reportTime);
        strictEqual(typeof reportId, 'number');

        const tb = await repo.getTrialBalanceReport(reportTime);
        strictEqual(tb.reportTime, reportTime);
        const lineA = tb.lines.find(l => l.accountCode === 2000);
        const lineB = tb.lines.find(l => l.accountCode === 3000);
        strictEqual(typeof lineA, 'object');
        strictEqual(typeof lineB, 'object');

        const bs = await repo.getBalanceSheetReport(reportTime);
        strictEqual(bs.reportTime, reportTime);
        const bsA = bs.lines.find(l => l.accountCode === 2000);
        const bsB = bs.lines.find(l => l.accountCode === 3000);
        strictEqual(typeof bsA, 'object');
        strictEqual(typeof bsB, 'object');
      });
    });

    describe('sql helpers and not-found behaviors', function () {
      it('sqlQuery should proxy to rawSql', async function () {
        const rows = await repo.sqlQuery('SELECT 1 as v', []);
        strictEqual(Array.isArray(rows), true);
        strictEqual((rows[0] as any).v, 1);
      });

      it('should return null for unknown account lookups', async function () {
        const missing = await repo.getAccountByCode(999999);
        strictEqual(missing, null);
      });
    });

    describe('getManyAccounts (inclusive OR filters)', function () {
      it('returns accounts matching codes, names, tags, or controlAccountCodes', async function () {
        // create accounts
        await repo.addAccount(4000, 'Cash', 'debit');
        await repo.addAccount(5000, 'Receivable', 'debit');
        await repo.addAccount(6000, 'Equity', 'credit');

        // tagging and parent-child relationship
        await repo.setAccountTag(4000, 'Asset');
        await repo.setAccountTag(6000, 'Equity');
        await repo.setControlAccount(5000, 6000);

        // filter by codes
        let res = await repo.getManyAccounts({ codes: [4000] });
        strictEqual(res.length, 1);
        strictEqual(res[0].code, 4000);

        // filter by names
        res = await repo.getManyAccounts({ names: ['Receivable'] });
        strictEqual(res.length, 1);
        strictEqual(res[0].code, 5000);

        // filter by tags
        res = await repo.getManyAccounts({ tags: ['Asset'] });
        strictEqual(res.length, 1);
        strictEqual(res[0].code, 4000);

        // filter by control account codes (should return children)
        res = await repo.getManyAccounts({ controlAccountCodes: [6000] });
        strictEqual(res.length, 1);
        strictEqual(res[0].code, 5000);

        // inclusive OR across filters: even if codes don't match, tag should match
        res = await repo.getManyAccounts({ codes: [9999], tags: ['Equity'] });
        strictEqual(res.findIndex(r => r.code === 6000) !== -1, true);
      });
    });

  });
}
