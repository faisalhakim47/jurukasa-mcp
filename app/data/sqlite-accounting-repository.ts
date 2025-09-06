import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { AccountingRepository } from '@app/data/accounting-repository.js';
import { assertArray } from '@app/tools/assertion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SqliteAccountingRepository extends AccountingRepository {
  #db: DatabaseSync;

  constructor(path: string) {
    super();
    this.#db = new DatabaseSync(path);
  }

  async connect(): Promise<void> {
    const schemaFiles = [
      join(__dirname, './sqlite-accounting-schema.sql'),
    ];
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = FULL;');
    this.#db.exec('PRAGMA temp_store = MEMORY;');
    this.#db.exec('PRAGMA cache_size = -32000;');
    this.#db.exec('PRAGMA mmap_size = 67108864;');
    for (const file of schemaFiles) {
      const schemaContent = await readFile(file, { encoding: 'utf-8' });
      const statements = schemaContent.split('-- EOS');
      for (const statement of statements) {
        const trimmedStatement = statement.trim();
        if (trimmedStatement && trimmedStatement.length > 0) {
          this.#db.exec(trimmedStatement);
        }
      }
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async sql<T extends unknown>(query: TemplateStringsArray, ...params: unknown[]): Promise<Array<T>> {
    const fullQuery = query.reduce(function (fullSql, partialSql, index) {
      return fullSql + partialSql + (index < params.length ? '?' : '');
    }, '');
    return this.rawSql(fullQuery, params);
  }

  async rawSql<T extends unknown>(query: string, params?: Array<unknown>): Promise<Array<T>> {
    const stmt = this.#db.prepare(query);
    const result = stmt.all(...(params ?? []).map(function (param) {
      if (typeof param === 'boolean') {
        return param ? 1 : 0;
      }
      else if (typeof param === 'string' || typeof param === 'number') {
        if (Number.isNaN(param)) {
          throw new Error('NaN is not a valid SQL parameter');
        }
        return param;
      }
      else if (param === null || param === undefined) {
        return null;
      }
      else {
        throw new Error('Unsupported parameter type');
      }
    }));
    assertArray(result, 'SQL query result is not an array');
    return result as Array<T>;
  }

}
