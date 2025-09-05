#!/usr/bin/env node

import { argv, env, stderr } from 'node:process';

import { AccountingRepository } from '@app/data/accounting-repository.js';
import { createAccountingMcpServer } from '@app/accounting-mcp-server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const [, , databaseUrlArg, databaseAuthTokenArg] = argv;

const databaseUrlEnv = env.DATABASE_URL;
const databaseUrl = databaseUrlArg ?? databaseUrlEnv ?? undefined;

const databaseAuthTokenEnv = env.DATABASE_AUTH_TOKEN;
const databaseAuthToken = databaseAuthTokenArg ?? databaseAuthTokenEnv ?? undefined;

async function interpretDatabaseUrl(url?: string, authToken?: string): Promise<AccountingRepository> {
  if (url?.startsWith('sqlite:')) {
    const { SqliteAccountingRepository } = await import('@app/data/sqlite-accounting-repository.js');
    const trimmedPath = url.slice('sqlite:'.length);
    const repo = new SqliteAccountingRepository(trimmedPath);
    return repo;
  }
  else if (url?.startsWith('libsql:')) {
    const { LibsqlAccountingRepository } = await import('@app/data/libsql-accounting-repository.js');
    const repo = new LibsqlAccountingRepository(url, authToken);
    return repo;
  }
  else if (url === ':memory:' || url === undefined) {
    const { SqliteAccountingRepository } = await import('@app/data/sqlite-accounting-repository.js');
    const repo = new SqliteAccountingRepository(url ?? ':memory:');
    return repo;
  }
  else {
    throw new Error(`Unsupported database URL: ${url}`);
  }
}

if (databaseUrl === undefined) {
  stderr.write('Warning: No database URL provided, using in-memory database.\n');
}

const accountingRepository = await interpretDatabaseUrl(databaseUrl, databaseAuthToken);
await accountingRepository.connect();

const server = createAccountingMcpServer(accountingRepository);
const transport = new StdioServerTransport();
await server.connect(transport);
