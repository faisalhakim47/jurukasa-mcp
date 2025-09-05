import { AccountingRepository } from '@app/data/accounting-repository.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod/v3';

export function defineDraftJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('draftJournalEntry', {
    title: 'Draft journal entry',
    description: 'Create a draft journal entry with specified date, description, and lines. Returns the journal entry reference number.',
    inputSchema: {
      date: z.string(),
      description: z.string(),
      lines: z.array(z.object({
        accountCode: z.number(),
        amount: z.number(),
        type: z.enum(['debit', 'credit']),
      })),
    },
  }, async function (params) {
    try {
      const entryTime = new Date(params.date).getTime();
      const journalLines = params.lines.map(line => ({
        accountCode: line.accountCode,
        debit: line.type === 'debit' ? line.amount : 0,
        credit: line.type === 'credit' ? line.amount : 0,
      }));

      const journalEntryRef = await repo.draftJournalEntry({
        entryTime,
        description: params.description,
        lines: journalLines,
      });

      return {
        content: [{
          type: 'text',
          text: `Draft journal entry created with ref ${journalEntryRef} for date ${params.date}.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating draft journal entry: ${(error as Error).message}` }],
      };
    }
  });
}

export function defineUpdateJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('updateJournalEntry', {
    title: 'Update journal entry',
    description: 'Update an existing journal entry draft with new date, description, and/or lines.',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string(),
      description: z.string(),
      lines: z.array(z.object({
        accountCode: z.number(),
        amount: z.number(),
        type: z.enum(['debit', 'credit']),
      })),
    },
  }, async function (params) {
    try {
      const entryTime = new Date(params.date).getTime();
      const journalLines = params.lines.map(line => ({
        accountCode: line.accountCode,
        debit: line.type === 'debit' ? line.amount : 0,
        credit: line.type === 'credit' ? line.amount : 0,
      }));

      await repo.updateJournalEntry(params.journalEntryRef, {
        entryTime,
        description: params.description,
        lines: journalLines,
      });

      return {
        content: [{
          type: 'text',
          text: `Journal entry ${params.journalEntryRef} updated successfully.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error updating journal entry: ${(error as Error).message}` }],
      };
    }
  });
}

export function definePostJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('postJournalEntry', {
    title: 'Post journal entry',
    description: 'Post a draft journal entry to make it final. Optionally specify a post date (defaults to current date).',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string().optional(),
    },
  }, async function (params) {
    try {
      const postTime = params.date ? new Date(params.date).getTime() : Date.now();
      await repo.postJournalEntry(params.journalEntryRef, postTime);

      return {
        content: [{
          type: 'text',
          text: `Journal entry ${params.journalEntryRef} posted successfully.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error posting journal entry: ${(error as Error).message}` }],
      };
    }
  });
}

export function defineDeleteManyJournalEntryDraftsMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('deleteManyJournalEntryDrafts', {
    title: 'Delete many journal entry drafts',
    description: 'Delete multiple draft journal entries that have not been posted yet.',
    inputSchema: {
      journalEntryRefs: z.array(z.number()),
    },
  }, async function (params) {
    if (params.journalEntryRefs.length === 0) {
      return {
        content: [{ type: 'text', text: 'No journal entry refs provided, nothing to delete.' }],
      };
    }

    try {
      await repo.deleteManyJournalEntryDrafts(params.journalEntryRefs);
      const results = params.journalEntryRefs.map(ref => `Draft journal entry ${ref} deleted.`);
      return {
        content: [{
          type: 'text',
          text: results.join('\n'),
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error deleting journal entry drafts: ${(error as Error).message}` }],
      };
    }
  });
}

export function defineReverseJournalEntryMCPTool(server: McpServer, repo: AccountingRepository) {
  server.registerTool('reverseJournalEntry', {
    title: 'Reverse journal entry',
    description: 'Create a reversal journal entry for a posted journal entry. The reversal will swap debits and credits of the original entry.',
    inputSchema: {
      journalEntryRef: z.number(),
      date: z.string(),
      description: z.string().optional(),
    },
  }, async function (params) {
    try {
      const reversalTime = new Date(params.date).getTime();
      const reversalRef = await repo.reverseJournalEntry(params.journalEntryRef, reversalTime, params.description);
      
      return {
        content: [{
          type: 'text',
          text: `Reversal journal entry created with ref ${reversalRef} for original entry ${params.journalEntryRef}.`,
        }],
      };
    }
    catch (error) {
      return {
        content: [{ type: 'text', text: `Error reversing journal entry: ${(error as Error).message}` }],
      };
    }
  });
}
