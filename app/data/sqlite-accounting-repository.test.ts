import { runAccountingRepositoryTestSuite } from '@app/data/accounting-repository-test-suite.js';
import { SqliteAccountingRepository } from '@app/data/sqlite-accounting-repository.js';

await runAccountingRepositoryTestSuite(
  async function () {
    const repo = new SqliteAccountingRepository(':memory:');
    await repo.connect();
    return repo;
  },
  async function (accountingRepository) {
    await accountingRepository.close();
  },
);
