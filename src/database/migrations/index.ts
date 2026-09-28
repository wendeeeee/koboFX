import { CreateCurrencies1790467200000 } from './1790467200000-CreateCurrencies';
import { CreateLedgerEnums1790553600000 } from './1790553600000-CreateLedgerEnums';
import { CreateUsersAndWallets1790553600001 } from './1790553600001-CreateUsersAndWallets';
import { CreateAccounts1790553600002 } from './1790553600002-CreateAccounts';
import { CreateTransactions1790553600003 } from './1790553600003-CreateTransactions';
import { CreateLedgerEntries1790553600004 } from './1790553600004-CreateLedgerEntries';
import { CreatePeriodLocks1790553600005 } from './1790553600005-CreatePeriodLocks';

/** Explicit, ordered list — no globbing, so the CLI and the test harness run the same set. */
export const MIGRATIONS = [
  CreateCurrencies1790467200000,
  CreateLedgerEnums1790553600000,
  CreateUsersAndWallets1790553600001,
  CreateAccounts1790553600002,
  CreateTransactions1790553600003,
  CreateLedgerEntries1790553600004,
  CreatePeriodLocks1790553600005,
];
