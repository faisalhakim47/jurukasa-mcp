import { runAccountingRepositoryTestSuite } from '@app/data/accounting-repository-test-suite.js';
import { LibsqlAccountingRepository } from '@app/data/libsql-accounting-repository.js';

await runAccountingRepositoryTestSuite(
  async function () {
    const repo = new LibsqlAccountingRepository(':memory:');
    await repo.connect();
    return repo;
  },
  async function (accountingRepository) {
    await accountingRepository.close();
  },
);
