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

-- account: chart of accounts; balance stored in smallest currency unit (integer)
-- normal_balance: 0 = debit-normal, 1 = credit-normal
CREATE TABLE account (
  code INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normal_balance INTEGER NOT NULL CHECK (normal_balance IN (0,1)),
  balance INTEGER NOT NULL DEFAULT 0, -- current running balance
  is_active INTEGER NOT NULL DEFAULT 1,
  is_posting_account INTEGER NOT NULL DEFAULT 1,
  control_account_code INTEGER REFERENCES account(code),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- account_tag: many-to-many small taxonomy for reporting / closing
CREATE TABLE account_tag (
  account_code INTEGER NOT NULL REFERENCES account(code),
  tag TEXT NOT NULL,
  PRIMARY KEY (account_code, tag)
);

-- journal_entry: header for a transaction/journal
-- post_time NULL = unposted (draft); when post_time is set, triggers validate and update balances
CREATE TABLE journal_entry (
  ref INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_time INTEGER NOT NULL,
  note TEXT,
  post_time INTEGER, -- set when posting
  fiscal_year_begin_time INTEGER REFERENCES fiscal_year(begin_time),
  source_type TEXT DEFAULT 'Manual',
  source_reference TEXT,
  created_by TEXT DEFAULT 'User'
);

-- journal_entry_line: lines for each journal; debit XOR credit > 0; composite PK for ordering
CREATE TABLE journal_entry_line (
  journal_entry_ref INTEGER NOT NULL REFERENCES journal_entry(ref),
  line_number INTEGER NOT NULL,
  account_code INTEGER NOT NULL REFERENCES account(code),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  reference TEXT,
  PRIMARY KEY (journal_entry_ref, line_number),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)),
  CHECK (debit > 0 OR credit > 0)
);

-- balance_report + trial_balance_line: generated snapshot tables for reporting
CREATE TABLE balance_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'Period End',
  fiscal_year_begin_time INTEGER REFERENCES fiscal_year(begin_time),
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE trial_balance_line (
  balance_report_id INTEGER NOT NULL REFERENCES balance_report(id),
  account_code INTEGER NOT NULL REFERENCES account(code),
  debit INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code)
);

-- balance_sheet_line: classification-based snapshot used by balance_sheet view
CREATE TABLE balance_sheet_line (
  balance_report_id INTEGER NOT NULL REFERENCES balance_report(id),
  account_code INTEGER NOT NULL REFERENCES account(code),
  classification TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (balance_report_id, account_code)
);

-- fiscal_year: period boundaries used by reporting and automated closing
CREATE TABLE fiscal_year (
  begin_time INTEGER NOT NULL PRIMARY KEY,
  end_time INTEGER NOT NULL,
  post_time INTEGER,
  closing_journal_entry_ref INTEGER REFERENCES journal_entry(ref),
  name TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0
);

-- cashflow reporting minimal tables
CREATE TABLE cashflow_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_time INTEGER NOT NULL,
  begin_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE cashflow_statement_line (
  cashflow_report_id INTEGER NOT NULL REFERENCES cashflow_report(id),
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
FROM journal_entry_line jel
JOIN journal_entry je ON je.ref = jel.journal_entry_ref
WHERE je.post_time IS NOT NULL;

-- journal_entry_line_auto_number: convenience view to allow inserting lines without specifying line_number
CREATE VIEW journal_entry_line_auto_number AS
SELECT journal_entry_ref, line_number, account_code, debit, credit, description, reference
FROM journal_entry_line;
-- Note: an INSTEAD OF INSERT trigger provides auto-numbering behavior (see triggers).

-- trial_balance: combines report header + trial_balance_line for easy querying
CREATE VIEW trial_balance AS
SELECT br.id AS balance_report_id, br.report_time, br.report_type, br.name, tbl.account_code, a.name AS account_name, a.normal_balance, tbl.debit, tbl.credit
FROM balance_report br
JOIN trial_balance_line tbl ON tbl.balance_report_id = br.id
JOIN account a ON a.code = tbl.account_code;

-- balance_sheet: exposes balance_sheet_line with account names
CREATE VIEW balance_sheet AS
SELECT br.id AS balance_report_id, br.report_time, br.report_type, br.name, bsl.classification, bsl.category, bsl.account_code, a.name AS account_name, bsl.amount
FROM balance_report br
JOIN balance_sheet_line bsl ON bsl.balance_report_id = br.id
JOIN account a ON a.code = bsl.account_code;

-- income_statement: computed from fiscal_year_account_mutation (see view below)
CREATE VIEW income_statement AS
SELECT fyam.begin_time, fyam.end_time, fyam.account_code, fyam.account_name, fyam.net_change AS amount
FROM (
  SELECT fy.begin_time, fy.end_time, a.code AS account_code, a.name AS account_name,
    COALESCE(SUM(jes.debit) - SUM(jes.credit), 0) * (CASE a.normal_balance WHEN 0 THEN 1 ELSE -1 END) AS net_change
  FROM fiscal_year fy
  CROSS JOIN account a
  LEFT JOIN journal_entry_summary jes ON jes.entry_time > fy.begin_time AND jes.entry_time <= fy.end_time AND jes.account_code = a.code
  GROUP BY fy.begin_time, a.code
) fyam
WHERE fyam.net_change != 0;

-- cashflow_statement: simple join for cashflow lines
CREATE VIEW cashflow_statement AS
SELECT cr.id AS cashflow_report_id, cr.report_time, cr.begin_time, cr.end_time, cr.name, csl.activity_type, csl.line_description, csl.amount
FROM cashflow_report cr
JOIN cashflow_statement_line csl ON csl.cashflow_report_id = cr.id;

-- =====================
-- Triggers and documented behaviors (concise)
-- =====================

-- 1) journal_entry_insert_validation_trigger
--    - Prevents inserting entries with non-positive entry_time.

-- 2) journal_entry_post_validation_trigger
--    - When posting (setting post_time), ensures: journal balances to zero and has >= 2 lines.

-- 3) journal_entry_post_account_trigger
--    - AFTER posting: updates account.balance using journal_entry_line amounts and account.normal_balance.

-- 4) journal_entry_line_update/delete prevention
--    - Prevent changing or deleting lines of a posted journal entry.

-- 5) journal_entry_line_auto_number_trigger
--    - INSTEAD OF INSERT on journal_entry_line_auto_number view to auto-assign line_number

-- 6) trial_balance_generation_trigger
--    - After creating a balance_report, a trial balance snapshot is populated from account.balance.

-- 7) balance_sheet_generation_trigger
--    - After creating a balance_report, populate balance_sheet_line using account_tag classification.

-- 8) fiscal_year_post_account_trigger (automated closing) - concise behavior
--    - When a fiscal_year is posted (post_time set):
--      * system creates a closing journal_entry at fiscal end_time
--      * inserts lines to zero out accounts tagged for closing (Revenue/Expense/Dividend)
--      * posts the closing journal_entry and sets fiscal_year.is_closed and closing_journal_entry_ref

COMMIT TRANSACTION;