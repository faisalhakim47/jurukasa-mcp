-- Compact reference schema for user-level accounting (queryable objects + behavior notes)
-- Purpose: reference-only summary of tables, views, and key trigger behaviors for LLMs Compact and self-documented.

BEGIN TRANSACTION;

-- =====================
-- Tables (queryable schema)
-- =====================

-- user_config: simple key/value metadata for the user DB
CREATE TABLE user_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- accounts: chart of accounts; balance stored in smallest currency unit (integer)
-- normal_balance: 0 = debit-normal, 1 = credit-normal
CREATE TABLE accounts (
  account_code INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normal_balance INTEGER NOT NULL CHECK (normal_balance IN (0,1)),
  balance INTEGER NOT NULL DEFAULT 0, -- current running balance
  is_active INTEGER NOT NULL DEFAULT 1,
  is_posting_account INTEGER NOT NULL DEFAULT 1,
  control_account_code INTEGER REFERENCES accounts(account_code),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- account_tags: many-to-many small taxonomy for reporting / closing
-- Common tags include: 'Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 
-- 'Current Asset', 'Non-Current Asset', 'Balance Sheet - *', 'Income Statement - *', 
-- 'Fiscal Year Closing - *', 'Cash Flow - *' (see main schema for full list)
CREATE TABLE account_tags (
  account_code INTEGER NOT NULL REFERENCES accounts(account_code),
  tag TEXT NOT NULL,
  PRIMARY KEY (account_code, tag)
);

-- journal_entries: header for a transaction/journal
-- post_time NULL = unposted (draft); when post_time is set, triggers validate and update balances
CREATE TABLE journal_entries (
  ref INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_time INTEGER NOT NULL,
  note TEXT,
  post_time INTEGER, -- set when posting
  fiscal_year_begin_time INTEGER REFERENCES fiscal_years(begin_time),
  source_type TEXT DEFAULT 'Manual' CHECK (source_type IN ('Manual', 'LLM Generated', 'System Generated')),
  source_reference TEXT,
  created_by TEXT DEFAULT 'User' CHECK (created_by IN ('User', 'System', 'Migration')),
  reversal_of_ref INTEGER REFERENCES journal_entries(ref),
  reversed_by_ref INTEGER REFERENCES journal_entries(ref),
  idempotent_key TEXT
);

-- journal_entry_lines: lines for each journal; debit XOR credit > 0; composite PK for ordering
CREATE TABLE journal_entry_lines (
  journal_entry_ref INTEGER NOT NULL REFERENCES journal_entries(ref),
  line_number INTEGER NOT NULL,
  account_code INTEGER NOT NULL REFERENCES accounts(account_code),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  reference TEXT,
  PRIMARY KEY (journal_entry_ref, line_number),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)),
  CHECK (debit > 0 OR credit > 0)
);

-- balance_reports + trial_balance_lines: generated snapshot tables for reporting
CREATE TABLE balance_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'Period End',
  fiscal_year_begin_time INTEGER REFERENCES fiscal_years(begin_time),
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE trial_balance_lines (
  balance_report_id INTEGER NOT NULL REFERENCES balance_reports(id),
  account_code INTEGER NOT NULL REFERENCES accounts(account_code),
  debit INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code)
);

-- balance_sheet_lines: classification-based snapshot used by balance_sheet view
CREATE TABLE balance_sheet_lines (
  balance_report_id INTEGER NOT NULL REFERENCES balance_reports(id),
  account_code INTEGER NOT NULL REFERENCES accounts(account_code),
  classification TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code)
);

-- fiscal_years: period boundaries used by reporting and automated closing
CREATE TABLE fiscal_years (
  begin_time INTEGER NOT NULL PRIMARY KEY,
  end_time INTEGER NOT NULL,
  post_time INTEGER,
  closing_journal_entry_ref INTEGER REFERENCES journal_entries(ref),
  name TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0
);

-- cashflow reporting minimal tables
CREATE TABLE cashflow_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  begin_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE cashflow_statement_lines (
  cashflow_report_id INTEGER NOT NULL REFERENCES cashflow_reports(id),
  activity_type TEXT NOT NULL,
  line_description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (cashflow_report_id, activity_type, line_description)
);

-- =====================
-- Views (queryable summaries)
-- =====================

-- journal_entry_summary: flattened posted journal lines; useful for queries and fiscal calculations
CREATE VIEW journal_entry_summary AS
SELECT je.ref, je.entry_time, je.note, je.post_time, jel.line_number, jel.account_code, jel.debit, jel.credit, jel.description
FROM journal_entry_lines jel
JOIN journal_entries je ON je.ref = jel.journal_entry_ref
WHERE je.post_time IS NOT NULL;

-- journal_entry_lines_auto_number: convenience view to allow inserting lines without specifying line_number
CREATE VIEW journal_entry_lines_auto_number AS
SELECT journal_entry_ref, line_number, account_code, debit, credit, description, reference
FROM journal_entry_lines;
-- Note: an INSTEAD OF INSERT trigger provides auto-numbering behavior (see triggers).

-- trial_balance: combines report header + trial_balance_lines for easy querying
CREATE VIEW trial_balance AS
SELECT br.id AS balance_report_id, br.report_time, br.report_type, br.name, tbl.account_code, a.name AS account_name, a.normal_balance, tbl.debit, tbl.credit
FROM balance_reports br
JOIN trial_balance_lines tbl ON tbl.balance_report_id = br.id
JOIN accounts a ON a.account_code = tbl.account_code;

-- balance_sheet: exposes balance_sheet_lines with account names
CREATE VIEW balance_sheet AS
SELECT br.id AS balance_report_id, br.report_time, br.report_type, br.name, bsl.classification, bsl.category, bsl.account_code, a.name AS account_name, bsl.amount
FROM balance_reports br
JOIN balance_sheet_lines bsl ON bsl.balance_report_id = br.id
JOIN accounts a ON a.account_code = bsl.account_code;

-- income_statement: computed from fiscal_year_account_mutation (see view below)
CREATE VIEW income_statement AS
SELECT fyam.begin_time, fyam.end_time, fyam.account_code, fyam.account_name, fyam.net_change AS amount
FROM (
  SELECT fy.begin_time, fy.end_time, a.account_code AS account_code, a.name AS account_name,
    COALESCE(SUM(jes.debit) - SUM(jes.credit), 0) * (CASE a.normal_balance WHEN 0 THEN 1 ELSE -1 END) AS net_change
  FROM fiscal_years fy
  CROSS JOIN accounts a
  LEFT JOIN journal_entry_summary jes ON jes.entry_time > fy.begin_time AND jes.entry_time <= fy.end_time AND jes.account_code = a.account_code
  GROUP BY fy.begin_time, a.account_code
) fyam
WHERE fyam.net_change != 0;

-- cashflow_statement: simple join for cashflow lines
CREATE VIEW cashflow_statement AS
SELECT cr.id AS cashflow_report_id, cr.report_time, cr.begin_time, cr.end_time, cr.name, csl.activity_type, csl.line_description, csl.amount
FROM cashflow_reports cr
JOIN cashflow_statement_lines csl ON csl.cashflow_report_id = cr.id;

-- =====================
-- Triggers and documented behaviors (concise)
-- =====================

-- 1) journal_entries_insert_validation_trigger
--    - Prevents inserting entries with non-positive entry_time.

-- 2) journal_entries_post_validation_trigger
--    - When posting (setting post_time), ensures: journal balances to zero and has >= 2 lines.

-- 3) journal_entries_post_account_trigger
--    - AFTER posting: updates accounts.balance using journal_entry_lines amounts and accounts.normal_balance.

-- 4) journal_entry_lines_update/delete prevention
--    - Prevent changing or deleting lines of a posted journal entry.

-- 5) journal_entry_lines_auto_number_trigger
--    - INSTEAD OF INSERT on journal_entry_lines_auto_number view to auto-assign line_number

-- 6) trial_balance_generation_trigger
--    - After creating a balance_reports, a trial balance snapshot is populated from accounts.balance.

-- 7) balance_sheet_generation_trigger
--    - After creating a balance_reports, populate balance_sheet_lines using account_tags classification.

-- 8) fiscal_years_post_account_trigger (automated closing) - concise behavior
--    - When a fiscal_years is posted (post_time set):
--      * system creates a closing journal_entries at fiscal end_time
--      * inserts lines to zero out accounts tagged for closing (Revenue/Expense/Dividend)
--      * posts the closing journal_entries and sets fiscal_years.is_closed and closing_journal_entry_ref

COMMIT TRANSACTION;