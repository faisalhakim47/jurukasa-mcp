-- ==========================================================================
-- JuruKasa User Accounting Database Migration Script
-- Version: 1.0
-- Date: 2025-08-18
-- 
-- This script creates the accounting schema for individual user databases.
-- Each user has their own isolated SQLite database containing their financial data.
-- 
-- Database Features:
-- - Complete double-entry accounting system
-- - IFRS/PSAK compliant financial reporting
-- - Automated fiscal year closing via triggers
-- - Multi-period financial statements
-- - Audit trail with immutable transaction history
-- - Chart of accounts with flexible tagging system
-- 
-- Migration Features:
-- - Idempotent (safe to run multiple times)
-- - ACID transaction boundary
-- - Performance-optimized indexes
-- - Automated balance calculations via triggers
-- - Each top-level statement is followed by end-of-statement marker
-- ==========================================================================

-- Optimize for accounting operations
-- PRAGMA journal_mode = WAL; -- EOS        -- Write-Ahead Logging for data safety
-- PRAGMA synchronous = FULL; -- EOS        -- Strong data integrity
PRAGMA foreign_keys = ON; -- EOS         -- Enforce referential integrity
-- PRAGMA temp_store = MEMORY; -- EOS       -- Store temporary data in memory
-- PRAGMA cache_size = -32000; -- EOS       -- 32MB cache (smaller than platform DB)
-- PRAGMA mmap_size = 67108864; -- EOS      -- 64MB memory-mapped I/O (reduced for CI)

-- Start transaction for atomic migration
BEGIN TRANSACTION; -- EOS

-- ==========================================================================
-- USER METADATA AND CONFIGURATION
-- ==========================================================================

-- User-specific configuration and metadata
CREATE TABLE IF NOT EXISTS user_config (
  key TEXT PRIMARY KEY CHECK (key IN (
    'Business Name',
    'Business Type',
    'Currency Code',
    'Currency Decimals',
    'Locale',
    'Fiscal Year Start Month'
  )),
  value TEXT NOT NULL CHECK (length(value) >= 0),
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS user_config_updated_at_index ON user_config (updated_at); -- EOS

-- Insert default user configuration
INSERT OR IGNORE INTO user_config (key, value, description, created_at, updated_at) VALUES
  ('Business Name', '', 'Business or entity name', 0, 0),
  ('Business Type', 'Small Business', 'Type of business entity', 0, 0),
  ('Currency Code', 'IDR', 'Base currency code (ISO 4217)', 0, 0),
  ('Currency Decimals', '0', 'Number of decimal places for currency (0 for IDR)', 0, 0),
  ('Locale', 'en-ID', 'ISO 639-1 and ISO 3166-1 separated by hyphen (e.g., en-US, en-ID)', 0, 0),
  ('Fiscal Year Start Month', '1', 'Fiscal year start month (1-12)', 0, 0); -- EOS

-- ==========================================================================
-- CHART OF ACCOUNTS
-- ==========================================================================

-- Account master - core of the accounting system
CREATE TABLE IF NOT EXISTS account (
  code INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normal_balance INTEGER NOT NULL CHECK (normal_balance IN (0, 1)), -- 0 = debit, 1 = credit
  balance INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_posting_account INTEGER NOT NULL DEFAULT 1 CHECK (is_posting_account IN (0, 1)),
  control_account_code INTEGER REFERENCES account (code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (control_account_code IS NULL OR control_account_code != code)
) STRICT; -- EOS

CREATE INDEX IF NOT EXISTS account_name_index ON account (name); -- EOS
CREATE INDEX IF NOT EXISTS account_active_index ON account (is_active, code) WHERE is_active = 1; -- EOS
CREATE INDEX IF NOT EXISTS account_posting_index ON account (is_posting_account, code) WHERE is_posting_account = 1; -- EOS
CREATE INDEX IF NOT EXISTS account_parent_index ON account (control_account_code) WHERE control_account_code IS NOT NULL; -- EOS
CREATE INDEX IF NOT EXISTS account_balance_index ON account (balance) WHERE balance != 0; -- EOS

-- Prevent assigning a control_account_code to an account when the target
-- control account has non-zero posted journal entry totals. The control
-- account must be zeroed-out (no net posted debit/credit) before it can be
-- used as a parent/control account.
DROP TRIGGER IF EXISTS account_control_set_on_insert_validation_trigger; -- EOS
CREATE TRIGGER account_control_set_on_insert_validation_trigger
BEFORE INSERT ON account FOR EACH ROW
WHEN NEW.control_account_code IS NOT NULL
BEGIN
  SELECT
    CASE
      WHEN (
        SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
        FROM journal_entry_line jel
        JOIN journal_entry je ON je.ref = jel.journal_entry_ref
        WHERE jel.account_code = NEW.control_account_code
          AND je.post_time IS NOT NULL
      ) != 0
      THEN RAISE(ABORT, 'Cannot set control_account_code on insert: target control account has non-zero posted entries')
    END;
END; -- EOS

DROP TRIGGER IF EXISTS account_control_set_on_update_validation_trigger; -- EOS
CREATE TRIGGER account_control_set_on_update_validation_trigger
BEFORE UPDATE ON account FOR EACH ROW
WHEN NEW.control_account_code IS NOT NULL AND (OLD.control_account_code IS NULL OR NEW.control_account_code != OLD.control_account_code)
BEGIN
  SELECT
    CASE
      WHEN (
        SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
        FROM journal_entry_line jel
        JOIN journal_entry je ON je.ref = jel.journal_entry_ref
        WHERE jel.account_code = NEW.control_account_code
          AND je.post_time IS NOT NULL
      ) != 0
      THEN RAISE(ABORT, 'Cannot set control_account_code on update: target control account has non-zero posted entries')
    END;
END; -- EOS

-- Maintain is_posting_account flag automatically:
-- - When a child is added with a control_account_code, mark the parent as non-posting (0).
-- - When a child's parent link is removed or changed, and the old parent has no remaining children,
--   mark the old parent as posting (1).
-- - When a child is deleted, update the parent's is_posting_account accordingly.

DROP TRIGGER IF EXISTS account_child_insert_trigger; -- EOS
CREATE TRIGGER account_child_insert_trigger
AFTER INSERT ON account FOR EACH ROW
WHEN NEW.control_account_code IS NOT NULL
BEGIN
  UPDATE account
  SET is_posting_account = 0,
      updated_at = NEW.updated_at
  WHERE code = NEW.control_account_code
    AND is_posting_account != 0;
END; -- EOS

DROP TRIGGER IF EXISTS account_child_update_trigger; -- EOS
CREATE TRIGGER account_child_update_trigger
AFTER UPDATE OF control_account_code ON account FOR EACH ROW
BEGIN
  -- Update old parent: if it now has no children, mark it as posting (1), otherwise keep non-posting (0)
  UPDATE account
  SET is_posting_account = CASE WHEN (
      SELECT COUNT(1) FROM account a WHERE a.control_account_code = OLD.control_account_code
    ) > 0 THEN 0 ELSE 1 END,
    updated_at = NEW.updated_at
  WHERE code = OLD.control_account_code
    AND OLD.control_account_code IS NOT NULL;

  -- Update new parent: ensure it's marked as non-posting (0)
  UPDATE account
  SET is_posting_account = 0,
      updated_at = NEW.updated_at
  WHERE code = NEW.control_account_code
    AND NEW.control_account_code IS NOT NULL
    AND is_posting_account != 0;
END; -- EOS

DROP TRIGGER IF EXISTS account_child_delete_trigger; -- EOS
CREATE TRIGGER account_child_delete_trigger
AFTER DELETE ON account FOR EACH ROW
WHEN OLD.control_account_code IS NOT NULL
BEGIN
  UPDATE account
  SET is_posting_account = CASE WHEN (
      SELECT COUNT(1) FROM account a WHERE a.control_account_code = OLD.control_account_code
    ) > 0 THEN 0 ELSE 1 END,
    updated_at = strftime('%s','now')
  WHERE code = OLD.control_account_code;
END; -- EOS


-- Account classification and reporting tags
CREATE TABLE IF NOT EXISTS account_tag (
  account_code INTEGER NOT NULL REFERENCES account (code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tag TEXT NOT NULL CHECK (tag IN (
    -- Account Types
    'Asset',
    'Liability',
    'Equity',
    'Revenue',
    'Expense',
    'Contra Asset',
    'Contra Liability',
    'Contra Equity',
    'Contra Revenue',
    'Contra Expense',

    -- Account Classifications
    'Current Asset',
    'Non-Current Asset',
    'Current Liability',
    'Non-Current Liability',

    -- Fiscal Year Closing Tags
    'Fiscal Year Closing - Retained Earning',
    'Fiscal Year Closing - Revenue',
    'Fiscal Year Closing - Expense',
    'Fiscal Year Closing - Dividend',
    
    -- Balance Sheet Classification
    'Balance Sheet - Current Asset',
    'Balance Sheet - Non-Current Asset',
    'Balance Sheet - Current Liability',
    'Balance Sheet - Non-Current Liability',
    'Balance Sheet - Equity',
    
    -- Income Statement Classification
    'Income Statement - Revenue',
    'Income Statement - Contra Revenue',
    'Income Statement - Other Revenue',
    'Income Statement - COGS',
    'Income Statement - Expense',
    'Income Statement - Other Expense',
    
    -- Cash Flow Statement Tags
    'Cash Flow - Cash Equivalents',
    'Cash Flow - Revenue',
    'Cash Flow - Expense',
    'Cash Flow - Activity - Operating',
    'Cash Flow - Activity - Investing',
    'Cash Flow - Activity - Financing',
    'Cash Flow - Non-Cash - Depreciation',
    'Cash Flow - Non-Cash - Amortization',
    'Cash Flow - Non-Cash - Impairment',
    'Cash Flow - Non-Cash - Gain/Loss',
    'Cash Flow - Non-Cash - Stock Compensation',
    'Cash Flow - Working Capital - Current Asset',
    'Cash Flow - Working Capital - Current Liability'
  )),
  PRIMARY KEY (account_code, tag)
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS account_tag_account_index ON account_tag (account_code); -- EOS
CREATE INDEX IF NOT EXISTS account_tag_tag_index ON account_tag (tag); -- EOS
CREATE INDEX IF NOT EXISTS account_tag_tag_account_index ON account_tag (tag, account_code); -- EOS

-- ==========================================================================
-- JOURNAL ENTRIES AND TRANSACTIONS
-- ==========================================================================

-- Journal entry header
CREATE TABLE IF NOT EXISTS journal_entry (
  ref INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_time INTEGER NOT NULL,
  note TEXT,
  post_time INTEGER,
  fiscal_year_begin_time INTEGER REFERENCES fiscal_year (begin_time) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_type TEXT DEFAULT 'Manual' CHECK (source_type IN ('Manual', 'LLM Generated', 'System Generated')),
  source_reference TEXT,
  created_by TEXT DEFAULT 'User' CHECK (created_by IN ('User', 'System', 'Migration')),
  reversal_of_ref INTEGER REFERENCES journal_entry (ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reversed_by_ref INTEGER REFERENCES journal_entry (ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotent_key TEXT
) STRICT; -- EOS

CREATE INDEX IF NOT EXISTS journal_entry_entry_time_index ON journal_entry (entry_time); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_entry_time_post_time_index ON journal_entry (entry_time, post_time); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_post_time_not_null_index ON journal_entry (post_time) WHERE post_time IS NOT NULL; -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_post_time_ref_index ON journal_entry (post_time, ref) WHERE post_time IS NOT NULL; -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_ref_post_time_index ON journal_entry(ref, post_time); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_fiscal_year_index ON journal_entry (fiscal_year_begin_time) WHERE fiscal_year_begin_time IS NOT NULL; -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_source_type_index ON journal_entry (source_type, entry_time); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_reversal_index ON journal_entry (reversal_of_ref) WHERE reversal_of_ref IS NOT NULL; -- EOS
CREATE UNIQUE INDEX IF NOT EXISTS journal_entry_idempotent_key_index ON journal_entry (idempotent_key) WHERE idempotent_key IS NOT NULL; -- EOS

-- Journal entry validation trigger
DROP TRIGGER IF EXISTS journal_entry_insert_validation_trigger; -- EOS
CREATE TRIGGER journal_entry_insert_validation_trigger
BEFORE INSERT ON journal_entry FOR EACH ROW
BEGIN
  -- Ensure entry time is valid
  SELECT
    CASE
      WHEN new.entry_time <= 0 THEN RAISE(ABORT, 'Entry time must be positive')
    END;
END; -- EOS

-- Prevent deletion of posted journal entries
DROP TRIGGER IF EXISTS journal_entry_delete_prevention_trigger; -- EOS
CREATE TRIGGER journal_entry_delete_prevention_trigger
BEFORE DELETE ON journal_entry FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN old.post_time IS NOT NULL THEN RAISE(ABORT, 'Cannot delete posted journal entry')
    END;
END; -- EOS

-- Journal entry line items
CREATE TABLE IF NOT EXISTS journal_entry_line (
  journal_entry_ref INTEGER NOT NULL REFERENCES journal_entry (ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  line_number INTEGER NOT NULL,
  account_code INTEGER NOT NULL REFERENCES account (code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  description TEXT, -- Line-specific description
  reference TEXT, -- External reference (invoice #, etc.)
  PRIMARY KEY (journal_entry_ref, line_number),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)),
  CHECK (debit > 0 OR credit > 0) -- At least one must be positive
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS journal_entry_line_account_debit_credit_index ON journal_entry_line (account_code, debit, credit); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_line_journal_account_index ON journal_entry_line(account_code, journal_entry_ref); -- EOS
CREATE INDEX IF NOT EXISTS journal_entry_line_ref_line_index ON journal_entry_line (journal_entry_ref, line_number); -- EOS

-- Prevent creating or modifying journal entry lines that post directly to
-- a control (parent) account. Posting must be done to posting (leaf)
-- accounts only.
DROP TRIGGER IF EXISTS journal_entry_line_control_account_insert_prevention_trigger; -- EOS
CREATE TRIGGER journal_entry_line_control_account_insert_prevention_trigger
BEFORE INSERT ON journal_entry_line FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN EXISTS(
        SELECT 1 FROM account a WHERE a.control_account_code = NEW.account_code LIMIT 1
      ) THEN RAISE(ABORT, 'Cannot post journal entry line to a control account on insert')
    END;
END; -- EOS

DROP TRIGGER IF EXISTS journal_entry_line_control_account_update_prevention_trigger; -- EOS
CREATE TRIGGER journal_entry_line_control_account_update_prevention_trigger
BEFORE UPDATE ON journal_entry_line FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN EXISTS(
        SELECT 1 FROM account a WHERE a.control_account_code = NEW.account_code LIMIT 1
      ) THEN RAISE(ABORT, 'Cannot post journal entry line to a control account on update')
    END;
END; -- EOS

-- Validation trigger for posting journal entries
DROP TRIGGER IF EXISTS journal_entry_post_validation_trigger; -- EOS
CREATE TRIGGER journal_entry_post_validation_trigger
BEFORE UPDATE ON journal_entry FOR EACH ROW
WHEN new.post_time IS NOT NULL AND old.post_time IS NULL
BEGIN
  -- Ensure journal entry balances
  SELECT
    CASE
      WHEN (SELECT SUM(debit) - SUM(credit) FROM journal_entry_line WHERE journal_entry_ref = new.ref) != 0 
      THEN RAISE(ABORT, 'Journal entry does not balance')
      WHEN (SELECT COUNT(*) FROM journal_entry_line WHERE journal_entry_ref = new.ref) < 2 
      THEN RAISE(ABORT, 'Journal entry must have at least 2 lines')
    END;
END; -- EOS

-- Update account balances when journal entry is posted
DROP TRIGGER IF EXISTS journal_entry_post_account_trigger; -- EOS
CREATE TRIGGER journal_entry_post_account_trigger
AFTER UPDATE ON journal_entry FOR EACH ROW
WHEN old.post_time IS NULL AND new.post_time IS NOT NULL
BEGIN
  UPDATE account
  SET balance = balance + (
    SELECT COALESCE(SUM(
      CASE account.normal_balance
        WHEN 0 THEN jel.debit - jel.credit  -- Debit normal: add debits, subtract credits
        WHEN 1 THEN jel.credit - jel.debit  -- Credit normal: add credits, subtract debits
      END
    ), 0)
    FROM journal_entry_line jel
    WHERE jel.journal_entry_ref = new.ref AND jel.account_code = account.code
  ),
  updated_at = new.post_time
  WHERE account.code IN (
    SELECT DISTINCT account_code
    FROM journal_entry_line
    WHERE journal_entry_ref = new.ref
  );
END; -- EOS

-- Prevent modification of posted journal entry lines
DROP TRIGGER IF EXISTS journal_entry_line_update_prevention_trigger; -- EOS
CREATE TRIGGER journal_entry_line_update_prevention_trigger
BEFORE UPDATE ON journal_entry_line FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN (SELECT post_time FROM journal_entry WHERE ref = old.journal_entry_ref) IS NOT NULL 
      THEN RAISE(ABORT, 'Cannot modify lines of posted journal entry')
    END;
END; -- EOS

-- Prevent deletion of posted journal entry lines
DROP TRIGGER IF EXISTS journal_entry_line_delete_prevention_trigger; -- EOS
CREATE TRIGGER journal_entry_line_delete_prevention_trigger
BEFORE DELETE ON journal_entry_line FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN (SELECT post_time FROM journal_entry WHERE ref = old.journal_entry_ref) IS NOT NULL 
      THEN RAISE(ABORT, 'Cannot delete lines of posted journal entry')
    END;
END; -- EOS

-- Auto-number journal entry lines for easier insertion
DROP VIEW IF EXISTS journal_entry_line_auto_number; -- EOS
CREATE VIEW journal_entry_line_auto_number AS
SELECT
  jel.journal_entry_ref,
  jel.line_number,
  jel.account_code,
  jel.debit,
  jel.credit,
  jel.description,
  jel.reference
FROM journal_entry_line jel; -- EOS

-- Auto-numbering trigger for journal entry lines
DROP TRIGGER IF EXISTS journal_entry_line_auto_number_trigger; -- EOS
CREATE TRIGGER journal_entry_line_auto_number_trigger
INSTEAD OF INSERT ON journal_entry_line_auto_number FOR EACH ROW
BEGIN
  INSERT INTO journal_entry_line (
    journal_entry_ref,
    line_number,
    account_code,
    debit,
    credit,
    description,
    reference
  )
  VALUES (
    new.journal_entry_ref,
    COALESCE(
      (SELECT MAX(line_number) + 1 FROM journal_entry_line WHERE journal_entry_ref = new.journal_entry_ref),
      1
    ),
    new.account_code,
    COALESCE(new.debit, 0),
    COALESCE(new.credit, 0),
    new.description,
    new.reference
  );
END; -- EOS

-- Summary view for posted journal entries
DROP VIEW IF EXISTS journal_entry_summary; -- EOS
CREATE VIEW journal_entry_summary AS
SELECT
  je.ref,
  je.entry_time,
  je.note,
  je.source_type,
  je.post_time,
  jel.line_number,
  jel.account_code,
  a.name AS account_name,
  jel.debit,
  jel.credit,
  jel.description,
  jel.reference
FROM journal_entry_line jel
JOIN journal_entry je ON je.ref = jel.journal_entry_ref
JOIN account a ON a.code = jel.account_code
WHERE je.post_time IS NOT NULL
ORDER BY je.ref ASC, jel.line_number ASC; -- EOS

-- ==========================================================================
-- FISCAL YEAR MANAGEMENT
-- ==========================================================================

-- Fiscal year periods
CREATE TABLE IF NOT EXISTS fiscal_year (
  begin_time INTEGER NOT NULL PRIMARY KEY,
  end_time INTEGER NOT NULL,
  post_time INTEGER,
  closing_journal_entry_ref INTEGER REFERENCES journal_entry (ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT, -- 'FY2024', 'Q1 2024', etc.
  is_closed INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
  CHECK (begin_time < end_time)
) STRICT; -- EOS

CREATE INDEX IF NOT EXISTS fiscal_year_end_time_index ON fiscal_year (end_time); -- EOS
CREATE INDEX IF NOT EXISTS fiscal_year_begin_end_time_index ON fiscal_year (begin_time, end_time); -- EOS
CREATE INDEX IF NOT EXISTS fiscal_year_post_time_index ON fiscal_year (post_time) WHERE post_time IS NOT NULL; -- EOS
CREATE INDEX IF NOT EXISTS fiscal_year_closed_index ON fiscal_year (is_closed, begin_time); -- EOS

-- Fiscal year validation trigger
DROP TRIGGER IF EXISTS fiscal_year_insert_validation_trigger; -- EOS
CREATE TRIGGER fiscal_year_insert_validation_trigger
BEFORE INSERT ON fiscal_year FOR EACH ROW
BEGIN
  -- Prevent overlapping fiscal years
  SELECT
    CASE
      WHEN EXISTS (
        SELECT 1 FROM fiscal_year 
        WHERE (new.begin_time < end_time AND new.end_time > begin_time)
      ) THEN RAISE(ABORT, 'Fiscal year periods cannot overlap')
    END;
  
  -- Validate fiscal year duration (must be reasonable)
  SELECT
    CASE
      WHEN (new.end_time - new.begin_time) < (30 * 24 * 60 * 60) -- Less than 30 days
      THEN RAISE(ABORT, 'Fiscal year must be at least 30 days')
      WHEN (new.end_time - new.begin_time) > (400 * 24 * 60 * 60) -- More than 400 days
      THEN RAISE(ABORT, 'Fiscal year cannot exceed 400 days')
    END;
END; -- EOS

-- Prevent posting if there are unbalanced entries
DROP TRIGGER IF EXISTS fiscal_year_post_validation_trigger; -- EOS
CREATE TRIGGER fiscal_year_post_validation_trigger
BEFORE UPDATE ON fiscal_year FOR EACH ROW
WHEN new.post_time IS NOT NULL AND old.post_time IS NULL
BEGIN
  SELECT
    CASE
      WHEN EXISTS (
        SELECT 1 FROM journal_entry je
        LEFT JOIN journal_entry_line jel ON jel.journal_entry_ref = je.ref
        WHERE je.entry_time > new.begin_time 
          AND je.entry_time <= new.end_time
          AND je.post_time IS NULL
      ) THEN RAISE(ABORT, 'Cannot close fiscal year with unposted journal entries')
    END;
END; -- EOS

-- Account mutation view for fiscal year analysis
DROP VIEW IF EXISTS fiscal_year_account_mutation; -- EOS
CREATE VIEW fiscal_year_account_mutation AS
SELECT
  fy.begin_time,
  fy.end_time,
  a.code AS account_code,
  a.name AS account_name,
  a.normal_balance,
  COALESCE(SUM(jes.debit), 0) AS sum_of_debit,
  COALESCE(SUM(jes.credit), 0) AS sum_of_credit,
  COALESCE(SUM(
    CASE a.normal_balance
      WHEN 0 THEN jes.debit - jes.credit  -- Debit normal balance
      WHEN 1 THEN jes.credit - jes.debit  -- Credit normal balance
    END
  ), 0) AS net_change
FROM fiscal_year fy
CROSS JOIN account a
LEFT JOIN journal_entry_summary jes
  ON jes.entry_time > fy.begin_time
  AND jes.entry_time <= fy.end_time
  AND jes.account_code = a.code
WHERE a.is_active = 1
GROUP BY fy.begin_time, a.code
HAVING sum_of_debit != 0 OR sum_of_credit != 0; -- EOS

-- Automated fiscal year closing trigger
DROP TRIGGER IF EXISTS fiscal_year_post_account_trigger; -- EOS
CREATE TRIGGER fiscal_year_post_account_trigger
AFTER UPDATE ON fiscal_year FOR EACH ROW
WHEN old.post_time IS NULL AND new.post_time IS NOT NULL
BEGIN
  -- Create comprehensive closing entry
  INSERT INTO journal_entry (entry_time, note, fiscal_year_begin_time, source_type, created_by)
  VALUES (
    new.end_time, 
    'FY' || strftime('%Y', datetime(new.end_time, 'unixepoch')) || ' Closing Entry',
    new.begin_time,
    'System Generated',
    'System'
  );

  -- Revenue closing entries: debit revenue accounts to zero their credit balances
  INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
  SELECT 
    last_insert_rowid(),
    a.code,
    -- Debit side: if account has an effective debit balance to offset, or if credit-normal revenue has positive balance
    CASE
      WHEN a.normal_balance = 0 AND a.balance < 0 THEN ABS(a.balance)   -- debit-normal but has negative (credit) balance -> debit to offset
      WHEN a.normal_balance = 1 AND a.balance > 0 THEN a.balance        -- credit-normal and positive (credit) balance -> debit to offset
      ELSE 0
    END,
    -- Credit side: if account has an effective credit to offset
    CASE
      WHEN a.normal_balance = 0 AND a.balance > 0 THEN a.balance        -- debit-normal and positive (debit) balance -> credit to offset
      WHEN a.normal_balance = 1 AND a.balance < 0 THEN ABS(a.balance)   -- credit-normal but negative (debit) balance -> credit to offset
      ELSE 0
    END
  FROM account a
  JOIN account_tag at ON at.account_code = a.code
  WHERE at.tag = 'Fiscal Year Closing - Revenue'
    AND a.balance != 0;

  -- Expense closing entries: credit expense accounts to zero their debit balances
  INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
  SELECT 
    last_insert_rowid(),
    a.code,
    -- Debit side: if expense account currently has a credit (negative) balance -> debit to offset
    CASE
      WHEN a.normal_balance = 0 AND a.balance < 0 THEN ABS(a.balance)
      WHEN a.normal_balance = 1 AND a.balance > 0 THEN a.balance
      ELSE 0
    END,
    -- Credit side: if expense account has a debit (positive) balance -> credit to offset
    CASE
      WHEN a.normal_balance = 0 AND a.balance > 0 THEN a.balance
      WHEN a.normal_balance = 1 AND a.balance < 0 THEN ABS(a.balance)
      ELSE 0
    END -- Credit to zero existing balance
  FROM account a
  JOIN account_tag at ON at.account_code = a.code
  WHERE at.tag = 'Fiscal Year Closing - Expense'
    AND a.balance != 0;

  -- Dividend closing entries: credit dividend accounts to zero their debit balances
  INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
  SELECT 
    last_insert_rowid(),
    a.code,
    CASE
      WHEN a.normal_balance = 0 AND a.balance < 0 THEN ABS(a.balance)
      WHEN a.normal_balance = 1 AND a.balance > 0 THEN a.balance
      ELSE 0
    END,
    CASE
      WHEN a.normal_balance = 0 AND a.balance > 0 THEN a.balance
      WHEN a.normal_balance = 1 AND a.balance < 0 THEN ABS(a.balance)
      ELSE 0
    END -- Credit to zero existing balance
  FROM account a
  JOIN account_tag at ON at.account_code = a.code
  WHERE at.tag = 'Fiscal Year Closing - Dividend'
    AND a.balance != 0;

  -- Calculate net income for retained earnings balancing
  INSERT INTO journal_entry_line_auto_number (journal_entry_ref, account_code, debit, credit)
  SELECT 
    last_insert_rowid(),
    re.account_code,
    CASE WHEN calc.net_income > 0 THEN 0 ELSE ABS(calc.net_income) END,
    CASE WHEN calc.net_income > 0 THEN calc.net_income ELSE 0 END
  FROM (
    SELECT 
      COALESCE(SUM(
        CASE
          WHEN at.tag IN ('Fiscal Year Closing - Revenue', 'Fiscal Year Closing - Expense', 'Fiscal Year Closing - Dividend')
          THEN CASE WHEN a.normal_balance = 1 THEN a.balance ELSE -a.balance END
          ELSE 0
        END
      ), 0) AS net_income
    FROM account a
    JOIN account_tag at ON at.account_code = a.code
    WHERE at.tag IN ('Fiscal Year Closing - Revenue', 'Fiscal Year Closing - Expense', 'Fiscal Year Closing - Dividend')
  ) calc
  CROSS JOIN (
    SELECT code as account_code 
    FROM account 
    WHERE code IN (SELECT account_code FROM account_tag WHERE tag = 'Fiscal Year Closing - Retained Earning')
    LIMIT 1
  ) re
  WHERE calc.net_income != 0;

  -- Post the closing entry if it has at least 2 lines, otherwise delete it
  UPDATE journal_entry 
  SET post_time = new.end_time
  WHERE ref = last_insert_rowid()
    AND (SELECT COUNT(*) FROM journal_entry_line WHERE journal_entry_ref = last_insert_rowid()) >= 2;

  DELETE FROM journal_entry
  WHERE ref = last_insert_rowid()
    AND (SELECT COUNT(*) FROM journal_entry_line WHERE journal_entry_ref = last_insert_rowid()) < 2;

  -- Store closing journal entry reference if it exists
  UPDATE fiscal_year
  SET 
    closing_journal_entry_ref = (
      SELECT ref FROM journal_entry 
      WHERE ref = last_insert_rowid() 
        AND EXISTS (SELECT 1 FROM journal_entry_line WHERE journal_entry_ref = last_insert_rowid())
    ),
    is_closed = 1
  WHERE begin_time = new.begin_time 
    AND closing_journal_entry_ref IS NULL;
END; -- EOS

-- ==========================================================================
-- FINANCIAL REPORTING TABLES
-- ==========================================================================

-- Balance report generation
CREATE TABLE IF NOT EXISTS balance_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'Period End' CHECK (report_type IN ('Period End', 'Monthly', 'Quarterly', 'Annual', 'Ad Hoc')),
  fiscal_year_begin_time INTEGER REFERENCES fiscal_year (begin_time) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT, -- Human-readable report name
  created_at INTEGER NOT NULL
) STRICT; -- EOS

CREATE INDEX IF NOT EXISTS balance_report_report_time_index ON balance_report (report_time); -- EOS
CREATE INDEX IF NOT EXISTS balance_report_id_time_index ON balance_report (id, report_time); -- EOS
CREATE INDEX IF NOT EXISTS balance_report_type_time_index ON balance_report (report_type, report_time); -- EOS

-- Trial balance line items
CREATE TABLE IF NOT EXISTS trial_balance_line (
  balance_report_id INTEGER NOT NULL REFERENCES balance_report (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_code INTEGER NOT NULL REFERENCES account (code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  debit INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code),
  CHECK (debit >= 0 AND credit >= 0)
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS trial_balance_line_report_id_index ON trial_balance_line (balance_report_id); -- EOS
CREATE INDEX IF NOT EXISTS trial_balance_line_account_debit_credit_index ON trial_balance_line (account_code, debit, credit); -- EOS

-- Trial balance view
DROP VIEW IF EXISTS trial_balance; -- EOS
CREATE VIEW trial_balance AS
SELECT
  br.id AS balance_report_id,
  br.report_time,
  br.report_type,
  br.name,
  tbl.account_code,
  a.name AS account_name,
  a.normal_balance,
  tbl.debit,
  tbl.credit
FROM balance_report br
JOIN trial_balance_line tbl ON tbl.balance_report_id = br.id
JOIN account a ON a.code = tbl.account_code
ORDER BY br.report_time DESC, tbl.account_code; -- EOS

-- Auto-generate trial balance when balance report is created
DROP TRIGGER IF EXISTS trial_balance_generation_trigger; -- EOS
CREATE TRIGGER trial_balance_generation_trigger
AFTER INSERT ON balance_report FOR EACH ROW
BEGIN
  INSERT INTO trial_balance_line (
    balance_report_id,
    account_code,
    debit,
    credit
  )
  SELECT
    new.id,
    a.code,
    CASE 
      WHEN a.balance >= 0 AND a.normal_balance = 0 THEN a.balance  -- Debit normal, positive balance
      WHEN a.balance < 0 AND a.normal_balance = 1 THEN ABS(a.balance)  -- Credit normal, negative balance (shown as debit)
      ELSE 0 
    END AS debit,
    CASE 
      WHEN a.balance >= 0 AND a.normal_balance = 1 THEN a.balance  -- Credit normal, positive balance
      WHEN a.balance < 0 AND a.normal_balance = 0 THEN ABS(a.balance)  -- Debit normal, negative balance (shown as credit)
      ELSE 0 
    END AS credit
  FROM account a
  WHERE a.is_active = 1;
END; -- EOS

-- ==========================================================================
-- BALANCE SHEET REPORTING
-- ==========================================================================

-- Balance sheet line items
CREATE TABLE IF NOT EXISTS balance_sheet_line (
  balance_report_id INTEGER NOT NULL REFERENCES balance_report (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_code INTEGER NOT NULL REFERENCES account (code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('Assets', 'Liabilities', 'Equity')),
  category TEXT NOT NULL CHECK (category IN (
    'Current Assets', 'Non-Current Assets', 
    'Current Liabilities', 'Non-Current Liabilities', 
    'Equity'
  )),
  amount INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code)
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS balance_sheet_line_report_id_index ON balance_sheet_line (balance_report_id); -- EOS
CREATE INDEX IF NOT EXISTS balance_sheet_line_classification_category_index ON balance_sheet_line (classification, category, account_code); -- EOS
CREATE INDEX IF NOT EXISTS balance_sheet_line_report_classification_index ON balance_sheet_line (balance_report_id, classification, category); -- EOS

-- Balance sheet view
DROP VIEW IF EXISTS balance_sheet; -- EOS
CREATE VIEW balance_sheet AS
SELECT
  br.id AS balance_report_id,
  br.report_time,
  br.report_type,
  br.name,
  bsl.classification,
  bsl.category,
  bsl.account_code,
  a.name AS account_name,
  bsl.amount
FROM balance_report br
JOIN balance_sheet_line bsl ON bsl.balance_report_id = br.id
JOIN account a ON a.code = bsl.account_code
ORDER BY br.report_time DESC, bsl.classification, bsl.category, bsl.account_code; -- EOS

-- Auto-generate balance sheet when balance report is created
DROP TRIGGER IF EXISTS balance_sheet_generation_trigger; -- EOS
CREATE TRIGGER balance_sheet_generation_trigger
AFTER INSERT ON balance_report FOR EACH ROW
BEGIN
  INSERT INTO balance_sheet_line (
    balance_report_id,
    account_code,
    classification,
    category,
    amount
  )
  SELECT
    new.id,
    a.code,
    CASE 
      WHEN at.tag IN ('Balance Sheet - Current Asset', 'Balance Sheet - Non-Current Asset') THEN 'Assets'
      WHEN at.tag IN ('Balance Sheet - Current Liability', 'Balance Sheet - Non-Current Liability') THEN 'Liabilities'
      WHEN at.tag = 'Balance Sheet - Equity' THEN 'Equity'
    END AS classification,
    CASE 
      WHEN at.tag = 'Balance Sheet - Current Asset' THEN 'Current Assets'
      WHEN at.tag = 'Balance Sheet - Non-Current Asset' THEN 'Non-Current Assets'
      WHEN at.tag = 'Balance Sheet - Current Liability' THEN 'Current Liabilities'
      WHEN at.tag = 'Balance Sheet - Non-Current Liability' THEN 'Non-Current Liabilities'
      WHEN at.tag = 'Balance Sheet - Equity' THEN 'Equity'
    END AS category,
    a.balance AS amount
  FROM account a
  JOIN account_tag at ON at.account_code = a.code
  WHERE a.is_active = 1 
    AND at.tag IN (
      'Balance Sheet - Current Asset', 'Balance Sheet - Non-Current Asset',
      'Balance Sheet - Current Liability', 'Balance Sheet - Non-Current Liability',
      'Balance Sheet - Equity'
    )
  ORDER BY a.code ASC;
END; -- EOS

-- ==========================================================================
-- INCOME STATEMENT REPORTING
-- ==========================================================================

-- Income statement view (based on fiscal year mutations)
DROP VIEW IF EXISTS income_statement; -- EOS
CREATE VIEW income_statement AS
SELECT
  CASE 
    WHEN at.tag IN ('Income Statement - Revenue', 'Income Statement - Contra Revenue', 'Income Statement - Other Revenue') THEN 'Revenue'
    WHEN at.tag IN ('Income Statement - COGS') THEN 'Cost of Goods Sold'
    WHEN at.tag IN ('Income Statement - Expense', 'Income Statement - Other Expense') THEN 'Expenses'
    ELSE 'Other' -- Catch-all for any other tags
  END AS classification,
  CASE 
    WHEN at.tag = 'Income Statement - Revenue' THEN 'Revenue'
    WHEN at.tag = 'Income Statement - Contra Revenue' THEN 'Contra Revenue'
    WHEN at.tag = 'Income Statement - Other Revenue' THEN 'Other Revenue'
    WHEN at.tag = 'Income Statement - COGS' THEN 'Cost of Goods Sold'
    WHEN at.tag = 'Income Statement - Expense' THEN 'Operating Expenses'
    WHEN at.tag = 'Income Statement - Other Expense' THEN 'Other Expenses'
  END AS category,
  fyam.account_code,
  fyam.account_name,
  fyam.net_change AS amount,
  fyam.begin_time,
  fyam.end_time,
  fy.name AS fiscal_year_name
FROM fiscal_year_account_mutation fyam
JOIN account_tag at ON at.account_code = fyam.account_code
JOIN fiscal_year fy ON fy.begin_time = fyam.begin_time
WHERE fyam.net_change != 0
  AND at.tag IN (
    'Income Statement - Revenue',
    'Income Statement - Contra Revenue',
    'Income Statement - Other Revenue',
    'Income Statement - COGS',
    'Income Statement - Expense',
    'Income Statement - Other Expense'
  )
ORDER BY fyam.begin_time DESC, classification, category, fyam.account_code; -- EOS

-- ==========================================================================
-- CASH FLOW STATEMENT REPORTING
-- ==========================================================================

-- Cash flow reporting tables
CREATE TABLE IF NOT EXISTS cashflow_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  begin_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  fiscal_year_begin_time INTEGER REFERENCES fiscal_year (begin_time) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT,
  created_at INTEGER NOT NULL,
  CHECK (begin_time < end_time)
) STRICT; -- EOS

CREATE TABLE IF NOT EXISTS cashflow_statement_line (
  cashflow_report_id INTEGER NOT NULL REFERENCES cashflow_report (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('Operating', 'Investing', 'Financing')),
  line_description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (cashflow_report_id, activity_type, line_description)
) STRICT, WITHOUT ROWID; -- EOS

CREATE INDEX IF NOT EXISTS cashflow_statement_line_report_id_index ON cashflow_statement_line (cashflow_report_id); -- EOS
CREATE INDEX IF NOT EXISTS cashflow_statement_line_activity_index ON cashflow_statement_line (activity_type, line_description); -- EOS
CREATE INDEX IF NOT EXISTS cashflow_report_time_range_index ON cashflow_report (report_time, begin_time, end_time); -- EOS

-- Cash flow statement view
DROP VIEW IF EXISTS cashflow_statement; -- EOS
CREATE VIEW cashflow_statement AS
SELECT
  cr.id AS cashflow_report_id,
  cr.report_time,
  cr.begin_time,
  cr.end_time,
  cr.name,
  csl.activity_type,
  csl.line_description,
  csl.amount
FROM cashflow_report cr
JOIN cashflow_statement_line csl ON csl.cashflow_report_id = cr.id
ORDER BY cr.report_time DESC,
  CASE csl.activity_type
    WHEN 'Operating' THEN 1
    WHEN 'Investing' THEN 2
    WHEN 'Financing' THEN 3
  END,
  csl.line_description; -- EOS

-- Validate foreign key constraints
PRAGMA foreign_key_check; -- EOS

-- Commit the transaction
COMMIT TRANSACTION; -- EOS
