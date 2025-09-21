import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineRecordJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('RecordJournalEntry', {
    title: 'Record journal entry',
    description: 'Record journal entry with specified date, description, and lines.',
    inputSchema: {
      date: z.string().describe('date is in ISO format (yyyy-mm-dd HH:mm:ss)'),
      description: z.string().optional(),
      lines: z.array(z.object({
        accountCode: z.number(),
        amount: z.number(),
        type: z.enum(['debit', 'credit']),
      })),
      idempotentKey: z.string().optional().describe('provide optional idempotentKey to prevent duplicate entries'),
    },
  }, async function (params) {
    try {
      const entryTime = new Date(params.date).getTime();

      if (isNaN(entryTime)) {
        return { content: [{ type: 'text', text: 'Invalid date format. Please use ISO format (yyyy-mm-dd HH:mm:ss).' }] };
      }

      if (params.idempotentKey) {
        const existingJournalRef = await repo.getExistingJournalEntryByIdempotentKey(params.idempotentKey);
        if (existingJournalRef) {
          return { content: [{ type: 'text', text: `Journal entry idempotency key already used by journal entry ref ${existingJournalRef}. No new entry created.` }] };
        }
      }

      // Validate that all account codes exist
      const accountCodes = params.lines.map(line => line.accountCode);
      const uniqueAccountCodes = [...new Set(accountCodes)];
      
      if (uniqueAccountCodes.length > 0) {
        const existingAccounts = await repo.getManyAccountsByCodes(uniqueAccountCodes);
        const existingAccountCodes = new Set(existingAccounts.map(account => account.accountCode));
        
        const missingAccountCodes = uniqueAccountCodes.filter(code => !existingAccountCodes.has(code));
        
        if (missingAccountCodes.length > 0) {
          const missingCodesText = missingAccountCodes.join(', ');
          return { 
            content: [{ 
              type: 'text', 
              text: `Cannot record journal entry. The following account codes do not exist: ${missingCodesText}. Please create these accounts first using the account management tools.` 
            }] 
          };
        }
      }

      const journalLines = params.lines.map(line => ({
        accountCode: line.accountCode,
        debit: line.type === 'debit' ? line.amount : 0,
        credit: line.type === 'credit' ? line.amount : 0,
      }));

      const journalEntryRef = await repo.draftJournalEntry({
        entryTime,
        description: params.description,
        lines: journalLines,
        idempotentKey: params.idempotentKey,
      });

      await repo.postJournalEntry(journalEntryRef, entryTime);

      return {
        content: [{
          type: 'text',
          text: `Journal entry recorded with ref ${journalEntryRef} for date ${params.date}.`,
        }],
      };
    }
    catch (error) {
      return { content: [{ type: 'text', text: `Error creating draft journal entry: ${(error as Error).message}` }] };
    }
  });
}

export function defineReverseJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('ReverseJournalEntry', {
    title: 'Reverse journal entry',
    description: 'Create a reversal journal entry for a posted journal entry. The reversal will swap debits and credits of the original entry. Date is in ISO format (yyyy-mm-dd HH:mm:ss). Optionally provide an idempotentKey to prevent duplicate reversals.',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string(),
      description: z.string().optional(),
      idempotentKey: z.string().optional(),
    },
  }, async function (params) {
    try {
      const reversalTime = new Date(params.date).getTime();

      if (isNaN(reversalTime)) {
        return { content: [{ type: 'text', text: 'Invalid date format. Please use ISO format (yyyy-mm-dd HH:mm:ss).' }] };
      }

      // Check if idempotent key already exists to provide clearer error message
      if (params.idempotentKey) {
        const existingJournalRef = await repo.getExistingJournalEntryByIdempotentKey(params.idempotentKey);
        if (existingJournalRef) {
          return { content: [{ type: 'text', text: `Reversal idempotency key already used by journal entry ref ${existingJournalRef}. No new reversal created.` }] };
        }
      }

      const reversalRef = await repo.reverseJournalEntry(
        params.journalEntryRef,
        reversalTime,
        params.description,
        params.idempotentKey
      );

      return {
        content: [{
          type: 'text',
          text: `Reversal journal entry recorded with ref ${reversalRef} for original entry ${params.journalEntryRef}.`,
        }],
      };
    }
    catch (error) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('not found') || errorMessage.includes('not posted')) {
        return { content: [{ type: 'text', text: `Cannot reverse journal entry: ${errorMessage}` }] };
      } else if (errorMessage.includes('FOREIGN KEY')) {
        return { content: [{ type: 'text', text: `Cannot reverse journal entry ${params.journalEntryRef}. One or more account codes from the original entry no longer exist. This may indicate accounts were deleted after the original entry was posted.` }] };
      } else {
        return { content: [{ type: 'text', text: `Error reversing journal entry: ${errorMessage}` }] };
      }
    }
  });
}
