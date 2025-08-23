import { assertPropNumber, assertPropString } from '@app/tools/assertion.js';

type Account = {
  code: number;
  name: string;
  normalBalance: 'debit' | 'credit';
  balance: number;
}

type ChartOfAccount = {
  code: number;
  name: string;
  normalBalance: 'debit' | 'credit';
  balance: number;
  children: ChartOfAccount[];
}

type JournalEntryLine = {
  accountCode: number;
  debit: number;
  credit: number;
}

type DraftJournalEntryParams = {
  entryTime: number;
  description?: string | null;
  lines: JournalEntryLine[];
}

type TrialBalanceReportLine = {
  accountCode: number;
  accountName: string;
  normalBalance: 'debit' | 'credit';
  debit: number;
  credit: number;
}

type TrialBalanceReport = {
  reportTime: number;
  reportType: string;
  name: string;
  lines: TrialBalanceReportLine[];
}

type BalanceSheetReportLine = {
  classification: string;
  category: string;
  accountCode: number;
  accountName: string;
  amount: number;
}

type BalanceSheetReport = {
  reportTime: number;
  reportType: string;
  name: string;
  lines: BalanceSheetReportLine[];
}

export abstract class AccountingRepository {
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract sql<T extends unknown>(query: TemplateStringsArray, ...params: unknown[]): Promise<Array<T>>;
  abstract rawSql<T extends unknown>(query: string, params?: unknown[]): Promise<Array<T>>;

  async addAccount(code: number, name: string, normalBalance: 'debit' | 'credit'): Promise<void> {
  await this.sql`INSERT INTO account (code, name, normal_balance, is_active, created_at, updated_at) VALUES (${code}, ${name}, ${normalBalance === 'debit' ? 0 : 1}, ${1}, ${0}, ${0})`;
  }

  async setAccountName(code: number, name: string): Promise<void> {
    await this.sql`UPDATE account SET name = ${name} WHERE code = ${code}`;
  }

  async setControlAccount(code: number, controlAccountCode: number): Promise<void> {
    await this.sql`UPDATE account SET control_account_code = ${controlAccountCode} WHERE code = ${code}`;
  }

  async getHierarchicalChartOfAccounts(): Promise<ChartOfAccount[]> {
    throw new Error('Not implemented');
  }

  private async getAccountByCodeOrName(codeOrName: number | string): Promise<Account | null> {
    const result = await this.sql`
      SELECT a.code, a.name, a.normal_balance, a.balance
      FROM account a
      WHERE a.is_active = 1
        AND (
          a.code = ${isNaN(Number(codeOrName)) ? -1 : Number(codeOrName)}
          OR a.name = ${codeOrName}
        )
    `;
    if (result.length === 0) {
      return null;
    }
    const row = result[0];
    assertPropNumber(row, 'code', 'Account code is not a number');
    assertPropString(row, 'name', 'Account name is not a string');
    assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
    assertPropNumber(row, 'balance', 'Account balance is not a number');
    return {
      code: row.code,
      name: row.name,
      normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
      balance: row.balance,
    };
  }

  async getAccountByCode(code: number): Promise<Account | null> {
    return await this.getAccountByCodeOrName(code);
  }

  async getAccountByName(name: string): Promise<Account | null> {
    return await this.getAccountByCodeOrName(name);
  }

  async getAccountsByTag(tag: string, offset: number, limit: number): Promise<Account[]> {
    const result = await this.sql`
      SELECT a.code, a.name, a.normal_balance, a.balance
      FROM account a
      JOIN account_tag at ON a.code = at.account_code
      WHERE a.is_active = 1 AND at.tag = ${tag}
      ORDER BY a.code
      LIMIT ${limit} OFFSET ${offset}
    `;
    return result.map(function (row) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      assertPropString(row, 'name', 'Account name is not a string');
      assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
      assertPropNumber(row, 'balance', 'Account balance is not a number');
      return {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
      };
    });
  }

  async setAccountTag(code: number, tag: string): Promise<void> {
    await this.sql`INSERT OR REPLACE INTO account_tag (account_code, tag) VALUES (${code}, ${tag})`;
  }

  async unsetAccountTag(code: number, tag: string): Promise<void> {
    await this.sql`DELETE FROM account_tag WHERE account_code = ${code} AND tag = ${tag}`;
  }

  async draftJournalEntry(params: DraftJournalEntryParams): Promise<number> {
    const result = await this.sql<{ ref: number }>`
      INSERT INTO journal_entry (entry_time, note, post_time)
      VALUES (${params.entryTime}, ${params.description || null}, NULL)
      RETURNING ref
    `;
    if (result.length === 0) {
      throw new Error('Failed to create journal entry');
    }
    const journalEntryId = result[0].ref;
    for (const line of params.lines) {
      // use the auto-numbering view to insert lines and let the DB assign line_number
      await this.sql`
        INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
        VALUES (${journalEntryId}, ${line.accountCode}, ${line.debit}, ${line.credit})
      `;
    }
    return journalEntryId;
  }

  async postJournalEntry(journalEntryId: number, postTime: number): Promise<void> {
  await this.sql`UPDATE journal_entry SET post_time = ${postTime} WHERE ref = ${journalEntryId}`;
  }

  async generateFinancialReport(reportTime: number): Promise<number> {
    const result = await this.sql<{ id: number }>`
      INSERT INTO balance_report (report_time, report_type, name, created_at)
      VALUES (${reportTime}, 'Ad Hoc', ${'Ad Hoc Report'}, ${reportTime})
      RETURNING id
    `;
    if (result.length === 0) {
      throw new Error('Failed to create balance report');
    }
    assertPropNumber(result[0], 'id', 'Balance report ID is not a number');
    return result[0].id;
  }

  async getTrialBalanceReport(reportTime: number): Promise<TrialBalanceReport> {
    const reportResult = await this.sql`
      SELECT
        tb.report_time,
        tb.report_type,
        tb.name AS report_name,
        tb.account_code,
        tb.account_name,
        tb.normal_balance,
        tb.debit,
        tb.credit
      FROM trial_balance tb
      WHERE tb.report_time = ${reportTime}
    `;
    if (reportResult.length === 0) {
      throw new Error('Trial balance report not found');
    }
    const firstRow = reportResult[0];
    assertPropNumber(firstRow, 'report_time', 'Report time is not a number');
    assertPropString(firstRow, 'report_type', 'Report type is not a string');
    assertPropString(firstRow, 'report_name', 'Report name is not a string');
    return {
      reportTime: firstRow.report_time,
      reportType: firstRow.report_type,
      name: firstRow.report_name,
      lines: reportResult.map(function (row) {
        assertPropNumber(row, 'account_code', 'Account code is not a number');
        assertPropString(row, 'account_name', 'Account name is not a string');
        assertPropNumber(row, 'normal_balance', 'Normal balance is not a number');
        assertPropNumber(row, 'debit', 'Debit is not a number');
        assertPropNumber(row, 'credit', 'Credit is not a number');
        return {
          accountCode: row.account_code,
          accountName: row.account_name,
          normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
          debit: row.debit,
          credit: row.credit,
        };
      }),
    };
  }

  async getBalanceSheetReport(reportTime: number): Promise<BalanceSheetReport> {
    const reportResult = await this.sql`
      SELECT
        bs.report_time,
        bs.report_type,
        bs.name AS report_name,
        bs.classification,
        bs.category,
        bs.account_code,
        bs.account_name,
        bs.amount
      FROM balance_sheet bs
      WHERE bs.report_time = ${reportTime}
    `;
    if (reportResult.length === 0) {
      throw new Error('Balance sheet report not found');
    }
    const firstRow = reportResult[0];
    assertPropNumber(firstRow, 'report_time', 'Report time is not a number');
    assertPropString(firstRow, 'report_type', 'Report type is not a string');
    assertPropString(firstRow, 'report_name', 'Report name is not a string');
    return {
      reportTime: firstRow.report_time,
      reportType: firstRow.report_type,
      name: firstRow.report_name,
      lines: reportResult.map(function (row) {
        assertPropString(row, 'classification', 'Classification is not a string');
        assertPropString(row, 'category', 'Category is not a string');
        assertPropNumber(row, 'account_code', 'Account code is not a number');
        assertPropString(row, 'account_name', 'Account name is not a string');
        assertPropNumber(row, 'amount', 'Amount is not a number');
        return {
          classification: row.classification,
          category: row.category,
          accountCode: row.account_code,
          accountName: row.account_name,
          amount: row.amount,
        };
      }),
    };
  }

  async sqlQuery(query: string, params?: unknown[]): Promise<Array<unknown>> {
    return await this.rawSql(query, params);
  }
}
