import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Predefined account tags extracted from sqlite-accounting-schema.sql
// These correspond to the CHECK constraint in the account_tag table
export const ACCOUNT_TAGS = {
  'Account Types': [
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
  ],
  'Account Classifications': [
    'Current Asset',
    'Non-Current Asset',
    'Current Liability',
    'Non-Current Liability',
  ],
  'Fiscal Year Closing Tags': [
    'Fiscal Year Closing - Retained Earning',
    'Fiscal Year Closing - Revenue',
    'Fiscal Year Closing - Expense',
    'Fiscal Year Closing - Dividend',
  ],
  'Balance Sheet Classification': [
    'Balance Sheet - Current Asset',
    'Balance Sheet - Non-Current Asset',
    'Balance Sheet - Current Liability',
    'Balance Sheet - Non-Current Liability',
    'Balance Sheet - Equity',
  ],
  'Income Statement Classification': [
    'Income Statement - Revenue',
    'Income Statement - Contra Revenue',
    'Income Statement - Other Revenue',
    'Income Statement - COGS',
    'Income Statement - Expense',
    'Income Statement - Other Expense',
  ],
  'Cash Flow Statement Tags': [
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
    'Cash Flow - Working Capital - Current Liability',
  ],
} as const;

// Flatten all tags for validation and reference
export const ALL_ACCOUNT_TAGS = Object.values(ACCOUNT_TAGS).flat();

function generateAccountTagsReference(): string {
  const sections = Object.entries(ACCOUNT_TAGS).map(([category, tags]) => {
    const tagList = tags.map(tag => `  - "${tag}"`).join('\n');
    return `## ${category}\n${tagList}`;
  });

  return `# Predefined Account Tags Reference

This resource provides all valid account tags that can be used with the SetManyAccountTags and UnsetManyAccountTags tools.

These tags are defined in the database schema and correspond to the CHECK constraint in the account_tag table.

Total available tags: ${ALL_ACCOUNT_TAGS.length}

${sections.join('\n\n')}

## Usage

When using account tagging tools, the 'tag' parameter must be one of the exact string values listed above.

Examples:
- Use "Asset" for basic asset classification
- Use "Current Asset" for balance sheet classification
- Use "Cash Flow - Cash Equivalents" for cash flow statement preparation
- Use "Fiscal Year Closing - Revenue" for accounts that need to be closed during fiscal year-end

## Categories Explanation

- **Account Types**: Basic accounting equation classifications
- **Account Classifications**: Current vs non-current distinctions
- **Fiscal Year Closing Tags**: Used for automated year-end closing procedures
- **Balance Sheet Classification**: Specific sections within the balance sheet
- **Income Statement Classification**: Revenue, expense, and COGS categorization
- **Cash Flow Statement Tags**: For cash flow statement preparation and analysis
`;
}

function generateAccountTagsJson(): string {
  return JSON.stringify({
    accountTags: ACCOUNT_TAGS,
    allTags: ALL_ACCOUNT_TAGS,
    totalCount: ALL_ACCOUNT_TAGS.length,
    categories: Object.keys(ACCOUNT_TAGS),
  }, null, 2);
}

export function defineAccountTagsMCPResource(server: McpServer) {
  // Markdown reference resource
  server.registerResource(
    'account-tags-reference',
    'account-tags://reference',
    {
      title: 'Account Tags Reference (Markdown)',
      description: 'Complete reference guide for all valid account tags with categories and usage examples',
      mimeType: 'text/markdown',
    },
    async function () {
      return {
        contents: [{
          uri: 'account-tags://reference',
          mimeType: 'text/markdown',
          text: generateAccountTagsReference(),
        }],
      };
    }
  );

  // JSON data resource for programmatic access
  server.registerResource(
    'account-tags-data',
    'account-tags://data',
    {
      title: 'Account Tags Data (JSON)',
      description: 'Structured JSON data of all valid account tags organized by category',
      mimeType: 'application/json',
    },
    async function () {
      return {
        contents: [{
          uri: 'account-tags://data',
          mimeType: 'application/json',
          text: generateAccountTagsJson(),
        }],
      };
    }
  );
}