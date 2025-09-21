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

        const reportId = await repo.GenerateFinancialReport(reportTime);
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

      it('should get latest trial balance and balance sheet reports', async function () {
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

        const reportId = await repo.GenerateFinancialReport(reportTime);
        strictEqual(typeof reportId, 'number');

        // Test ViewLatestTrialBalance
        const latestTb = await repo.viewLatestTrialBalance();
        strictEqual(latestTb?.reportTime, reportTime);
        const tbLineA = latestTb?.lines.find(l => l.accountCode === 2000);
        const tbLineB = latestTb?.lines.find(l => l.accountCode === 3000);
        strictEqual(typeof tbLineA, 'object');
        strictEqual(typeof tbLineB, 'object');

        // Test ViewLatestBalanceSheet
        const latestBs = await repo.viewLatestBalanceSheet();
        strictEqual(latestBs?.reportTime, reportTime);
        const bsLineA = latestBs?.lines.find(l => l.accountCode === 2000);
        const bsLineB = latestBs?.lines.find(l => l.accountCode === 3000);
        strictEqual(typeof bsLineA, 'object');
        strictEqual(typeof bsLineB, 'object');

        // Test with fromDate
        const futureDate = new Date(reportTime + 1000).toISOString();
        const latestTbWithDate = await repo.viewLatestTrialBalance(futureDate);
        strictEqual(latestTbWithDate?.reportTime, reportTime);

        const latestBsWithDate = await repo.viewLatestBalanceSheet(futureDate);
        strictEqual(latestBsWithDate?.reportTime, reportTime);

        // Test with past date (should return null)
        const pastDate = new Date(reportTime - 1000).toISOString();
        const noTb = await repo.viewLatestTrialBalance(pastDate);
        strictEqual(noTb, null);

        const noBs = await repo.viewLatestBalanceSheet(pastDate);
        strictEqual(noBs, null);
      });
    });

    describe('journal entries with idempotentKey', function () {
      it('should handle idempotent draft journal entries', async function () {
        await repo.addAccount(8000, 'Cash ID', 'debit');
        await repo.addAccount(9000, 'Revenue ID', 'credit');

        const now = Date.now();
        const idempotentKey = 'test-key-' + now;

        // Create first entry with idempotent key
        const entryId1 = await repo.draftJournalEntry({
          entryTime: now,
          description: 'First entry',
          lines: [
            { accountCode: 8000, debit: 100, credit: 0 },
            { accountCode: 9000, debit: 0, credit: 100 },
          ],
          idempotentKey,
        });

        // Create second entry with same idempotent key - should return same ID
        const entryId2 = await repo.draftJournalEntry({
          entryTime: now,
          description: 'Duplicate entry',
          lines: [
            { accountCode: 8000, debit: 200, credit: 0 },
            { accountCode: 9000, debit: 0, credit: 200 },
          ],
          idempotentKey,
        });

        strictEqual(entryId1, entryId2, 'Should return same entry ID for same idempotent key');

        // Post the entry and verify balances
        await repo.postJournalEntry(entryId1, now);
        const cashAccount = await repo.getAccountByCode(8000);
        const revenueAccount = await repo.getAccountByCode(9000);
        
        // Should have the first entry's amounts, not the second
        strictEqual(cashAccount?.balance, 100, 'Should have first entry amount');
        strictEqual(revenueAccount?.balance, 100, 'Should have first entry amount');
      });

      it('should allow updating idempotentKey in journal entries', async function () {
        await repo.addAccount(8100, 'Cash Update', 'debit');
        await repo.addAccount(9100, 'Revenue Update', 'credit');

        const now = Date.now();
        const entryId = await repo.draftJournalEntry({
          entryTime: now,
          description: 'Initial entry',
          lines: [
            { accountCode: 8100, debit: 50, credit: 0 },
            { accountCode: 9100, debit: 0, credit: 50 },
          ],
        });

        const newIdempotentKey = 'updated-key-' + now;
        await repo.updateJournalEntry(entryId, {
          idempotentKey: newIdempotentKey,
        });

        // Verify the key was updated by trying to create another entry with the same key
        const duplicateId = await repo.draftJournalEntry({
          entryTime: now + 1000,
          description: 'Should be duplicate',
          lines: [
            { accountCode: 8100, debit: 75, credit: 0 },
            { accountCode: 9100, debit: 0, credit: 75 },
          ],
          idempotentKey: newIdempotentKey,
        });

        strictEqual(entryId, duplicateId, 'Should return same entry ID for updated idempotent key');
      });

      it('should handle idempotent reversal journal entries', async function () {
        await repo.addAccount(8200, 'Cash Reversal', 'debit');
        await repo.addAccount(9200, 'Revenue Reversal', 'credit');

        const now = Date.now();
        const originalRef = await repo.draftJournalEntry({
          entryTime: now,
          description: 'Original entry for reversal',
          lines: [
            { accountCode: 8200, debit: 150, credit: 0 },
            { accountCode: 9200, debit: 0, credit: 150 },
          ],
        });

        await repo.postJournalEntry(originalRef, now);

        const reversalTime = now + 1000;
        const reversalIdempotentKey = 'reversal-key-' + now;

        // Create first reversal with idempotent key
        const reversalRef1 = await repo.reverseJournalEntry(
          originalRef, 
          reversalTime, 
          'First reversal',
          reversalIdempotentKey
        );

        // Create second reversal with same idempotent key - should return same ID
        const reversalRef2 = await repo.reverseJournalEntry(
          originalRef, 
          reversalTime, 
          'Duplicate reversal',
          reversalIdempotentKey
        );

        strictEqual(reversalRef1, reversalRef2, 'Should return same reversal ID for same idempotent key');

        // Post the reversal and verify balances
        await repo.postJournalEntry(reversalRef1, reversalTime);
        const cashAccount = await repo.getAccountByCode(8200);
        const revenueAccount = await repo.getAccountByCode(9200);
        
        strictEqual(cashAccount?.balance, 0, 'Cash balance should be zero after reversal');
        strictEqual(revenueAccount?.balance, 0, 'Revenue balance should be zero after reversal');
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

        // no filters should return all accounts
        res = await repo.getManyAccounts({});
        strictEqual(res.length, 3);
        strictEqual(res.findIndex(r => r.code === 4000) !== -1, true);
        strictEqual(res.findIndex(r => r.code === 5000) !== -1, true);
        strictEqual(res.findIndex(r => r.code === 6000) !== -1, true);
      });
    });

    describe('deleteManyJournalEntryDrafts and ReverseJournalEntry', function () {
      it('should delete multiple draft journal entries', async function () {
        // Create accounts
        await repo.addAccount(7000, 'Cash Test', 'debit');
        await repo.addAccount(8000, 'Revenue Test', 'credit');

        // Create multiple drafts
        const ref1 = await repo.draftJournalEntry({
          entryTime: Date.now(),
          description: 'Draft 1',
          lines: [
            { accountCode: 7000, debit: 100, credit: 0 },
            { accountCode: 8000, debit: 0, credit: 100 },
          ],
        });

        const ref2 = await repo.draftJournalEntry({
          entryTime: Date.now(),
          description: 'Draft 2',
          lines: [
            { accountCode: 7000, debit: 200, credit: 0 },
            { accountCode: 8000, debit: 0, credit: 200 },
          ],
        });

        // Delete the drafts
        await repo.deleteManyJournalEntryDrafts([ref1, ref2]);

        // Verify they are deleted by checking if they still exist in the database
        const remainingEntries = await repo.rawSql('SELECT ref FROM journal_entry WHERE ref IN (?, ?)', [ref1, ref2]);
        strictEqual(remainingEntries.length, 0, 'Journal entries should be deleted');
      });

      it('should reverse a posted journal entry', async function () {
        // Create accounts
        await repo.addAccount(9000, 'Cash Reverse', 'debit');
        await repo.addAccount(10000, 'Revenue Reverse', 'credit');

        // Create and post original entry
        const originalRef = await repo.draftJournalEntry({
          entryTime: Date.now() - 1000,
          description: 'Original entry',
          lines: [
            { accountCode: 9000, debit: 500, credit: 0 },
            { accountCode: 10000, debit: 0, credit: 500 },
          ],
        });
        await repo.postJournalEntry(originalRef, Date.now() - 1000);

        // Reverse the entry
        const reversalTime = Date.now();
        const reversalRef = await repo.reverseJournalEntry(originalRef, reversalTime, 'Reversal entry');

        // Verify reversal was created
        strictEqual(typeof reversalRef, 'number', 'Should return a reversal reference');

        // Check that balances are zeroed out after reversal (since reversal is still draft)
        const cashAccount = await repo.getAccountByCode(9000);
        const revenueAccount = await repo.getAccountByCode(10000);
        strictEqual(cashAccount?.balance, 500, 'Cash should still have original balance before posting reversal');
        strictEqual(revenueAccount?.balance, 500, 'Revenue should still have original balance before posting reversal');

        // Post the reversal
        await repo.postJournalEntry(reversalRef, reversalTime);

        // Now balances should be zero
        const cashAfter = await repo.getAccountByCode(9000);
        const revenueAfter = await repo.getAccountByCode(10000);
        strictEqual(cashAfter?.balance, 0, 'Cash balance should be zero after reversal');
        strictEqual(revenueAfter?.balance, 0, 'Revenue balance should be zero after reversal');
      });
    });

  });
}
