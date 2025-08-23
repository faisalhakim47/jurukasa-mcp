import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountingRepository } from '@app/data/accounting-repository.js';
import { assertArray } from '@app/tools/assertion.js';
import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class LibsqlAccountingRepository extends AccountingRepository {
  #lib: Client;

  constructor(url: string, authToken?: string) {
    super();
    this.#lib = createClient({ url, authToken });
  }

  async connect(): Promise<void> {
    const schemaFiles = [
      join(__dirname, './sqlite-accounting-schema.sql'),
    ];
    for (const file of schemaFiles) {
      const schemaContent = await readFile(file, { encoding: 'utf-8' });
      await this.#lib.executeMultiple(schemaContent);
    }
  }

  async close(): Promise<void> {
    this.#lib.close();
  }

  async sql<T extends unknown>(query: TemplateStringsArray, ...params: unknown[]): Promise<Array<T>> {
    const fullQuery = query.reduce(function (fullSql, partialSql, index) {
      return fullSql + partialSql + (index < params.length ? '?' : '');
    }, '');
    return this.rawSql(fullQuery, params);
  }

  async rawSql<T extends unknown>(query: string, params?: Array<unknown>): Promise<Array<T>> {
    const validParams = (params ?? []).map(function (param) {
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
    });
    const result = await this.#lib.execute(query, validParams);
    if (result.rows === undefined) {
      return [];
    }
    const array = Array.from(result.rows);
    assertArray(array);
    return array as Array<T>;
  }

}
