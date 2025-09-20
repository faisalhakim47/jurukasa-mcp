import { assertPropNullableNumber, assertPropNumber, assertPropString } from '@app/tools/assertion.js';

export type UserConfig = {
  businessName: string | null;
  businessType: string | null;
  currencyCode: string | null;
  currencyDecimalPlaces: number | null;
  locale?: string | null;
  fiscalYearStartMonth?: number | null;
};

type Account = {
  code: number;
  name: string;
  normalBalance: 'debit' | 'credit';
  balance: number;
  controlAccountCode: number | null;
  isActive: boolean | null;
}

type AccountInput = {
  code: number;
  name: string;
  normalBalance?: 'debit' | 'credit';
  controlAccountCode?: Account | null;
}

type ChartOfAccountQuery = {
  includeInactive?: boolean;
};

export type ChartOfAccount = {
  code: number;
  name: string;
  normalBalance: 'debit' | 'credit';
  balance: number;
  children: ChartOfAccount[];
}

type AccountTagInput = {
  accountCode: number;
  tag: string;
}

type AccountUpdateParams = {
  name?: string;
  controlCode?: number | null;
  deactivate?: boolean;
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
  idempotentKey?: string | null;
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

  async getUserConfig() {
    const result = await this.sql`
      SELECT key, value
      FROM user_config
    `;

    const config = {
      businessName: null,
      businessType: null,
      currencyCode: null,
      currencyDecimalPlaces: null,
    } as UserConfig;

    for (const row of result) {
      assertPropString(row, 'key', 'Config key is not a string');
      if (row.key === 'Business Name') {
        assertPropString(row, 'value', 'Business Name value is not a string');
        config.businessName = row.value;
      } else if (row.key === 'Business Type') {
        assertPropString(row, 'value', 'Business Type value is not a string');
        config.businessType = row.value;
      } else if (row.key === 'Currency Code') {
        assertPropString(row, 'value', 'Currency Code value is not a string');
        config.currencyCode = row.value;
      } else if (row.key === 'Currency Decimals') {
        // Handle both string and number values for compatibility
        if (typeof row.value === 'number') {
          config.currencyDecimalPlaces = row.value;
        } else if (typeof row.value === 'string' && !isNaN(Number(row.value))) {
          config.currencyDecimalPlaces = Number(row.value);
        } else {
          assertPropNumber(row, 'value', 'Currency Decimals value is not a number');
        }
      } else if (row.key === 'Locale') {
        assertPropString(row, 'value', 'Locale value is not a string');
        config.locale = row.value;
      } else if (row.key === 'Fiscal Year Start Month') {
        // Handle both string and number values for compatibility
        if (typeof row.value === 'number') {
          config.fiscalYearStartMonth = row.value;
        } else if (typeof row.value === 'string' && !isNaN(Number(row.value))) {
          config.fiscalYearStartMonth = Number(row.value);
        } else {
          assertPropNumber(row, 'value', 'Fiscal Year Start Month value is not a number');
        }
      }
    }

    return config;
  }

  async setUserConfig(config: UserConfig): Promise<void> {
    const now = Date.now();
    if (config.businessName !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Business Name', ${config.businessName}, ${now}, ${now})`;
    }
    if (config.businessType !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Business Type', ${config.businessType}, ${now}, ${now})`;
    }
    if (config.currencyCode !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Currency Code', ${config.currencyCode}, ${now}, ${now})`;
    }
    if (config.currencyDecimalPlaces !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Currency Decimals', ${config.currencyDecimalPlaces}, ${now}, ${now})`;
    }
    if (config.locale !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Locale', ${config.locale}, ${now}, ${now})`;
    }
    if (config.fiscalYearStartMonth !== undefined) {
      await this.sql`INSERT OR REPLACE INTO user_config (key, value, created_at, updated_at) VALUES ('Fiscal Year Start Month', ${config.fiscalYearStartMonth}, ${now}, ${now})`;
    }
  }

  /**
   * Ensure that the given accounts exist in the database. On conflict, do nothing.
   * The normalBalance and controlAccountCode are optional and nullable. When undefined then ignored, when null then set to null.
   */
  async ensureManyAccounts(accounts: AccountInput[]): Promise<void> {
    for (const account of accounts) {
      if (account.normalBalance !== undefined && account.controlAccountCode !== undefined) {
        await this.sql`INSERT INTO account (code, name, normal_balance, control_account_code, is_active, created_at, updated_at) VALUES (${account.code}, ${account.name}, ${account.normalBalance === 'debit' ? 0 : 1}, ${account.controlAccountCode ? account.controlAccountCode.code : null}, ${1}, ${0}, ${0}) ON CONFLICT(code) DO NOTHING`;
      } else if (account.normalBalance !== undefined) {
        await this.sql`INSERT INTO account (code, name, normal_balance, is_active, created_at, updated_at) VALUES (${account.code}, ${account.name}, ${account.normalBalance === 'debit' ? 0 : 1}, ${1}, ${0}, ${0}) ON CONFLICT(code) DO NOTHING`;
      } else if (account.controlAccountCode !== undefined) {
        await this.sql`INSERT INTO account (code, name, control_account_code, is_active, created_at, updated_at) VALUES (${account.code}, ${account.name}, ${account.controlAccountCode ? account.controlAccountCode.code : null}, ${1}, ${0}, ${0}) ON CONFLICT(code) DO NOTHING`;
      } else {
        await this.sql`INSERT INTO account (code, name, is_active, created_at, updated_at) VALUES (${account.code}, ${account.name}, ${1}, ${0}, ${0}) ON CONFLICT(code) DO NOTHING`;
      }
    }
  }

  async addAccount(code: number, name: string, normalBalance: 'debit' | 'credit'): Promise<void> {
    await this.sql`INSERT INTO account (code, name, normal_balance, is_active, created_at, updated_at) VALUES (${code}, ${name}, ${normalBalance === 'debit' ? 0 : 1}, ${1}, ${0}, ${0})`;
  }

  async setAccountName(code: number, name: string): Promise<void> {
    await this.sql`UPDATE account SET name = ${name} WHERE code = ${code}`;
  }

  async setControlAccount(code: number, controlAccountCode: number): Promise<void> {
    await this.sql`UPDATE account SET control_account_code = ${controlAccountCode} WHERE code = ${code}`;
  }

  async updateAccount(code: number, updates?: AccountUpdateParams): Promise<void> {
    await this.sql`
      UPDATE account SET
        name = COALESCE(${updates?.name}, name),
        control_account_code = CASE
          WHEN ${updates?.controlCode} IS NOT NULL THEN ${updates?.controlCode}
          ELSE control_account_code
        END,
        is_active = CASE
          WHEN ${updates?.deactivate} = TRUE THEN 0
          WHEN ${updates?.deactivate} = FALSE THEN 1
          ELSE is_active
        END
      WHERE code = ${code}
    `;
  }

  async ViewChartOfAccounts(query?: ChartOfAccountQuery): Promise<ChartOfAccount[]> {
    const includeInactive = query?.includeInactive ? 1 : 0;
    // Use a recursive CTE to walk the parent->child (control_account_code) relationships.
    // Start with top-level accounts (control_account_code IS NULL) and recurse to children.
    // includeInactive is a numeric flag (0 or 1). When 0, only include active accounts (is_active = 1).
    // When 1, include all accounts regardless of is_active.
    const rows = await this.sql`
      WITH RECURSIVE tree(code, name, normal_balance, balance, control_account_code, depth, path) AS (
        SELECT code, name, normal_balance, balance, control_account_code, 0 AS depth, printf('%04d', code) as path
        FROM account
        WHERE (${includeInactive} = 1 OR is_active = 1)
          AND control_account_code IS NULL
        UNION ALL
        SELECT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, tree.depth + 1, tree.path || ',' || printf('%04d', a.code)
        FROM account a
        JOIN tree ON a.control_account_code = tree.code
      )
      SELECT * FROM tree ORDER BY path;
    `;

    // Build map of nodes
    const nodeMap = new Map<number, ChartOfAccount>();
    for (const row of rows) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      assertPropString(row, 'name', 'Account name is not a string');
      assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
      assertPropNumber(row, 'balance', 'Account balance is not a number');
      const node: ChartOfAccount = {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
        children: [],
      };
      nodeMap.set(row.code, node);
    }

    // Attach children to parents and collect roots
    const roots: ChartOfAccount[] = [];
    for (const row of rows) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      // control_account_code can be null for root accounts, so only assert if not null
      if (row.control_account_code !== null) {
        assertPropNumber(row, 'control_account_code', 'Account control_account_code is not a number');
      }
      const node = nodeMap.get(row.code)!;
      if (row.control_account_code == null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(row.control_account_code);
        if (parent) {
          parent.children.push(node);
        } else {
          // Orphaned node (parent not returned), treat as root to avoid data loss
          roots.push(node);
        }
      }
    }

    return roots;
  }

  private async getManyAccountsByCodesOrNames(codesOrNames: Array<number | string>): Promise<Account[]> {
    if (codesOrNames.length === 0) {
      return [];
    }
    const placeholders = codesOrNames
      .map(function () { return '?'; })
      .join(', ');
    const result = await this.rawSql(`
      SELECT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
      FROM account a
      WHERE a.is_active = 1
        AND (
          a.code IN (${placeholders})
          OR a.name IN (${placeholders})
        )
    `, [
      ...codesOrNames,
      ...codesOrNames,
    ]);
    return result.map(function (row) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      assertPropString(row, 'name', 'Account name is not a string');
      assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
      assertPropNumber(row, 'balance', 'Account balance is not a number');
      assertPropNullableNumber(row, 'control_account_code', 'Account control_account_code is not a number');
      assertPropNullableNumber(row, 'is_active', 'Account is_active is not a number');
      return {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
        controlAccountCode: row.control_account_code,
        isActive: row.is_active === 1,
      };
    });
  }

  async getManyAccountsByCodes(codes: number[]): Promise<Account[]> {
    return await this.getManyAccountsByCodesOrNames(codes);
  }

  async getManyAccountsByNames(names: string[]): Promise<Account[]> {
    return await this.getManyAccountsByCodesOrNames(names);
  }

  /**
   * Fetch many accounts by inclusive OR across provided filters.
   * Any combination of the filters may be provided. If none are provided returns all active accounts.
   */
  async getManyAccounts(filters: { codes?: number[]; names?: string[]; tags?: string[]; controlAccountCodes?: number[] } = {}): Promise<Account[]> {
    const { codes, names, tags, controlAccountCodes } = filters;

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (codes && codes.length > 0) {
      const ph = codes.map(function () { return '?'; }).join(', ');
      whereClauses.push(`a.code IN (${ph})`);
      params.push(...codes);
    }

    if (names && names.length > 0) {
      const ph = names.map(function () { return '?'; }).join(', ');
      whereClauses.push(`a.name IN (${ph})`);
      params.push(...names);
    }

    if (controlAccountCodes && controlAccountCodes.length > 0) {
      const ph = controlAccountCodes.map(function () { return '?'; }).join(', ');
      whereClauses.push(`a.control_account_code IN (${ph})`);
      params.push(...controlAccountCodes);
    }

    if (tags && tags.length > 0) {
      const ph = tags.map(function () { return '?'; }).join(', ');
      // use a subquery to filter accounts that have any of the provided tags
      whereClauses.push(`a.code IN (SELECT account_code FROM account_tag WHERE tag IN (${ph}))`);
      params.push(...tags);
    }

    let sql: string;
    if (whereClauses.length > 0) {
      sql = `
        SELECT DISTINCT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
        FROM account a
        WHERE ${whereClauses.join(' OR ')}
        ORDER BY a.code
      `;
    } else {
      sql = `
        SELECT DISTINCT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
        FROM account a
        ORDER BY a.code
      `;
    }

    const result = await this.rawSql(sql, params);
    return result.map(function (row) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      assertPropString(row, 'name', 'Account name is not a string');
      assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
      assertPropNumber(row, 'balance', 'Account balance is not a number');
      assertPropNullableNumber(row, 'control_account_code', 'Account control_account_code is not a number');
      assertPropNullableNumber(row, 'is_active', 'Account is_active is not a number');
      return {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
        controlAccountCode: row.control_account_code,
        isActive: row.is_active === 1,
      };
    });
  }

  private async getAccountByCodeOrName(codeOrName: number | string): Promise<Account | null> {
    const result = await this.sql`
      SELECT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
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
    assertPropNullableNumber(row, 'control_account_code', 'Account control_account_code is not a number');
    assertPropNullableNumber(row, 'is_active', 'Account is_active is not a number');
    return {
      code: row.code,
      name: row.name,
      normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
      balance: row.balance,
      controlAccountCode: row.control_account_code,
      isActive: row.is_active === 1,
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
      SELECT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
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
      assertPropNullableNumber(row, 'control_account_code', 'Account control_account_code is not a number');
      assertPropNullableNumber(row, 'is_active', 'Account is_active is not a number');
      return {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
        controlAccountCode: row.control_account_code,
        isActive: row.is_active === 1,
      };
    });
  }

  async setAccountTag(code: number, tag: string): Promise<void> {
    await this.sql`INSERT OR REPLACE INTO account_tag (account_code, tag) VALUES (${code}, ${tag})`;
  }

  async unsetAccountTag(code: number, tag: string): Promise<void> {
    await this.sql`DELETE FROM account_tag WHERE account_code = ${code} AND tag = ${tag}`;
  }

  async getManyAccountsByOneOfManyTags(tags: string[], offset: number, limit: number): Promise<Account[]> {
    if (tags.length === 0) {
      return [];
    }
    const placeholders = tags
      .map(function () { return '?'; })
      .join(', ');
    const result = await this.rawSql(`
      SELECT DISTINCT a.code, a.name, a.normal_balance, a.balance, a.control_account_code, a.is_active
      FROM account a
      JOIN account_tag at ON a.code = at.account_code
      WHERE a.is_active = 1 AND at.tag IN (${placeholders})
      ORDER BY a.code
      LIMIT ? OFFSET ?
    `, [
      ...tags,
      limit,
      offset,
    ]);
    return result.map(function (row) {
      assertPropNumber(row, 'code', 'Account code is not a number');
      assertPropString(row, 'name', 'Account name is not a string');
      assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
      assertPropNumber(row, 'balance', 'Account balance is not a number');
      assertPropNullableNumber(row, 'control_account_code', 'Account control_account_code is not a number');
      assertPropNullableNumber(row, 'is_active', 'Account is_active is not a number');
      return {
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance === 0 ? 'debit' : 'credit',
        balance: row.balance,
        controlAccountCode: row.control_account_code,
        isActive: row.is_active === 1,
      };
    });
  }

  async SetManyAccountTags(input: Array<AccountTagInput>): Promise<void> {
    for (const item of input) {
      try {
        await this.sql`INSERT OR REPLACE INTO account_tag (account_code, tag) VALUES (${item.accountCode}, ${item.tag})`;
      } catch (error) {
        // If foreign key constraint fails (account doesn't exist), continue silently
        // This allows the operation to complete gracefully for non-existent accounts
        continue;
      }
    }
  }

  async UnsetManyAccountTags(input: Array<AccountTagInput>): Promise<void> {
    for (const item of input) {
      await this.sql`DELETE FROM account_tag WHERE account_code = ${item.accountCode} AND tag = ${item.tag}`;
    }
  }

  async getExistingJournalEntryByIdempotentKey(idempotentKey: string): Promise<number | null> {
    const result = await this.sql<{ ref: number }>`
      SELECT ref FROM journal_entry WHERE idempotent_key = ${idempotentKey}
    `;
    if (result.length === 0) {
      return null;
    }
    assertPropNumber(result[0], 'ref', 'Journal entry ref is not a number');
    return result[0].ref;
  }

  async draftJournalEntry(params: DraftJournalEntryParams): Promise<number> {
    // Check if an entry with the same idempotent key already exists
    if (params.idempotentKey) {
      const existingEntry = await this.sql<{ ref: number }>`
        SELECT ref FROM journal_entry WHERE idempotent_key = ${params.idempotentKey}
      `;
      if (existingEntry.length > 0) {
        return existingEntry[0].ref;
      }
    }

    const result = await this.sql<{ ref: number }>`
      INSERT INTO journal_entry (entry_time, note, post_time, idempotent_key)
      VALUES (${params.entryTime}, ${params.description || null}, NULL, ${params.idempotentKey || null})
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
    // Check if the journal entry exists and its current status
    const entry = await this.sql<{ post_time: number | null }>`
      SELECT post_time FROM journal_entry WHERE ref = ${journalEntryId}
    `;

    if (entry.length === 0) {
      throw new Error(`Journal entry ${journalEntryId} does not exist`);
    }

    if (entry[0].post_time !== null) {
      throw new Error(`Journal entry ${journalEntryId} is already posted`);
    }

    await this.sql`UPDATE journal_entry SET post_time = ${postTime} WHERE ref = ${journalEntryId}`;
  }

  async updateJournalEntry(journalEntryRef: number, params: { entryTime?: number; description?: string | null; lines?: JournalEntryLine[]; idempotentKey?: string | null }): Promise<void> {
    // First check if the journal entry exists
    const entry = await this.sql<{ post_time: number | null }>`
      SELECT post_time FROM journal_entry WHERE ref = ${journalEntryRef}
    `;

    if (entry.length === 0) {
      throw new Error(`Journal entry ${journalEntryRef} does not exist`);
    }

    if (entry[0].post_time !== null) {
      throw new Error(`Journal entry ${journalEntryRef} is already posted and cannot be updated`);
    }

    // Update journal entry header if provided
    if (params.entryTime !== undefined || params.description !== undefined || params.idempotentKey !== undefined) {
      const updates = [];
      const values = [];

      if (params.entryTime !== undefined) {
        updates.push('entry_time = ?');
        values.push(params.entryTime);
      }
      if (params.description !== undefined) {
        updates.push('note = ?');
        values.push(params.description);
      }
      if (params.idempotentKey !== undefined) {
        updates.push('idempotent_key = ?');
        values.push(params.idempotentKey);
      }

      if (updates.length > 0) {
        values.push(journalEntryRef);
        await this.rawSql(`UPDATE journal_entry SET ${updates.join(', ')} WHERE ref = ?`, values);
      }
    }

    // Update lines if provided
    if (params.lines !== undefined) {
      // Delete existing lines
      await this.sql`DELETE FROM journal_entry_line WHERE journal_entry_ref = ${journalEntryRef}`;

      // Insert new lines
      for (const line of params.lines) {
        await this.sql`
          INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
          VALUES (${journalEntryRef}, ${line.accountCode}, ${line.debit}, ${line.credit})
        `;
      }
    }
  }

  async deleteManyJournalEntryDrafts(journalEntryRefs: number[]): Promise<void> {
    if (journalEntryRefs.length === 0) {
      return;
    }

    const placeholders = journalEntryRefs.map(() => '?').join(', ');

    // Delete journal entry lines first
    await this.rawSql(`
      DELETE FROM journal_entry_line 
      WHERE journal_entry_ref IN (${placeholders})
    `, journalEntryRefs);

    // Then delete the journal entries
    await this.rawSql(`
      DELETE FROM journal_entry 
      WHERE ref IN (${placeholders}) 
      AND post_time IS NULL
    `, journalEntryRefs);
  }

  async reverseJournalEntry(journalEntryRef: number, reversalTime: number, description?: string, reversalIdempotentKey?: string): Promise<number> {
    // Get the original journal entry
    const originalEntry = await this.sql<{ ref: number; entry_time: number; note: string | null }>`
      SELECT ref, entry_time, note 
      FROM journal_entry 
      WHERE ref = ${journalEntryRef} 
      AND post_time IS NOT NULL
    `;

    if (originalEntry.length === 0) {
      throw new Error(`Journal entry ${journalEntryRef} not found or not posted`);
    }

    // Get the original lines
    const originalLines = await this.sql<{ account_code: number; debit: number; credit: number }>`
      SELECT account_code, debit, credit 
      FROM journal_entry_line 
      WHERE journal_entry_ref = ${journalEntryRef}
    `;

    // Create reversal lines (swap debit and credit)
    const reversalLines: JournalEntryLine[] = originalLines.map(line => ({
      accountCode: line.account_code,
      debit: line.credit,
      credit: line.debit,
    }));

    // Create the reversal journal entry
    const reversalDescription = description || `Reversal of journal entry ${journalEntryRef}`;
    const reversalRef = await this.draftJournalEntry({
      entryTime: reversalTime,
      description: reversalDescription,
      lines: reversalLines,
      idempotentKey: reversalIdempotentKey,
    });

    // Update reversal references
    await this.sql`
      UPDATE journal_entry 
      SET reversal_of_ref = ${journalEntryRef} 
      WHERE ref = ${reversalRef}
    `;

    await this.sql`
      UPDATE journal_entry 
      SET reversed_by_ref = ${reversalRef} 
      WHERE ref = ${journalEntryRef}
    `;

    return reversalRef;
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
        assertPropNumber(row, 'normal_balance', 'Account normal_balance is not a number');
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

  async ViewLatestTrialBalance(fromDate?: string): Promise<TrialBalanceReport | null> {
    const reportTime = fromDate ? new Date(fromDate).getTime() : Date.now();

    // First get the latest report_time
    const latestReportResult = await this.sql<{ report_time: number }>`
      SELECT report_time
      FROM trial_balance
      WHERE report_time <= ${reportTime}
      ORDER BY report_time DESC
      LIMIT 1
    `;

    if (latestReportResult.length === 0) {
      return null;
    }

    const latestReportTime = latestReportResult[0].report_time;

    // Then get all lines for that report
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
      WHERE tb.report_time = ${latestReportTime}
      ORDER BY tb.account_code
    `;

    if (reportResult.length === 0) {
      return null;
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

  async ViewLatestBalanceSheet(fromDate?: Date): Promise<BalanceSheetReport | null> {
    const reportTime = fromDate instanceof Date ? fromDate.getTime() : Date.now();

    // First get the latest report_time
    const latestReportResult = await this.sql<{ report_time: number }>`
      SELECT report_time
      FROM balance_sheet
      WHERE report_time <= ${reportTime}
      ORDER BY report_time DESC
      LIMIT 1
    `;

    if (latestReportResult.length === 0) {
      return null;
    }

    const latestReportTime = latestReportResult[0].report_time;

    // Then get all lines for that report
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
      WHERE bs.report_time = ${latestReportTime}
      ORDER BY bs.classification, bs.category, bs.account_code
    `;

    if (reportResult.length === 0) {
      return null;
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
