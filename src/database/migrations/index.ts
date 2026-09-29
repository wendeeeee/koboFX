import { CreateCurrencies1790467200000 } from './1790467200000-CreateCurrencies';
import { CreateLedgerEnums1790553600000 } from './1790553600000-CreateLedgerEnums';
import { CreateUsersAndWallets1790553600001 } from './1790553600001-CreateUsersAndWallets';
import { CreateAccounts1790553600002 } from './1790553600002-CreateAccounts';
import { CreateTransactions1790553600003 } from './1790553600003-CreateTransactions';
import { CreateLedgerEntries1790553600004 } from './1790553600004-CreateLedgerEntries';
import { CreatePeriodLocks1790553600005 } from './1790553600005-CreatePeriodLocks';
import { CreateReservations1790640000000 } from './1790640000000-CreateReservations';
import { ExtendUsersForAuthentication1790726400000 } from './1790726400000-ExtendUsersForAuthentication';
import { CreateAuditLogs1790726400001 } from './1790726400001-CreateAuditLogs';
import { CreateOutboxEvents1790726400002 } from './1790726400002-CreateOutboxEvents';
import { CreateOneTimePasswordChallenges1790726400003 } from './1790726400003-CreateOneTimePasswordChallenges';
import { CreateRefreshTokens1790726400004 } from './1790726400004-CreateRefreshTokens';
import { CreateFlowInstances1790812800000 } from './1790812800000-CreateFlowInstances';
import { CreateFundingPayments1790812800001 } from './1790812800001-CreateFundingPayments';
import { CreateIdempotencyKeys1790812800002 } from './1790812800002-CreateIdempotencyKeys';
import { CreateWebhookEvents1790812800003 } from './1790812800003-CreateWebhookEvents';
import { CreateProviderCalls1790812800004 } from './1790812800004-CreateProviderCalls';
import { CreateCurrencyPairs1790899200000 } from './1790899200000-CreateCurrencyPairs';
import { CreateExchangeRateSnapshots1790899200001 } from './1790899200001-CreateExchangeRateSnapshots';
import { CreateQuotes1790899200002 } from './1790899200002-CreateQuotes';
import { AddConversionFlowType1790985600000 } from './1790985600000-AddConversionFlowType';
import { ConversionFlowsAndProvenance1790985600001 } from './1790985600001-ConversionFlowsAndProvenance';

/** Explicit, ordered list — no globbing, so the CLI and the test harness run the same set. */
export const MIGRATIONS = [
  CreateCurrencies1790467200000,
  CreateLedgerEnums1790553600000,
  CreateUsersAndWallets1790553600001,
  CreateAccounts1790553600002,
  CreateTransactions1790553600003,
  CreateLedgerEntries1790553600004,
  CreatePeriodLocks1790553600005,
  CreateReservations1790640000000,
  ExtendUsersForAuthentication1790726400000,
  CreateAuditLogs1790726400001,
  CreateOutboxEvents1790726400002,
  CreateOneTimePasswordChallenges1790726400003,
  CreateRefreshTokens1790726400004,
  CreateFlowInstances1790812800000,
  CreateFundingPayments1790812800001,
  CreateIdempotencyKeys1790812800002,
  CreateWebhookEvents1790812800003,
  CreateProviderCalls1790812800004,
  CreateCurrencyPairs1790899200000,
  CreateExchangeRateSnapshots1790899200001,
  CreateQuotes1790899200002,
  AddConversionFlowType1790985600000,
  ConversionFlowsAndProvenance1790985600001,
];
