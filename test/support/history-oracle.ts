import { DataSource } from 'typeorm';

export type HistoryQueryParameters = Record<string, string>;


export async function expectedHistory(dataSource: DataSource, userId: string, query: HistoryQueryParameters): Promise<string[]> {
  const time = query.sort === 'bookingTime' ? 'booking_time' : 'value_time';
  const parameters: unknown[] = [userId];
  const bind = (value: unknown) => `$${parameters.push(value)}`;
  const transactionFilters: string[] = [];
  const fundingFilters: string[] = [];
  if (query.type) transactionFilters.push(`transactions.type::text = ${bind(query.type)}`);
  if (query.currency) {
    const currency = bind(query.currency);
    transactionFilters.push(`EXISTS (SELECT 1 FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
                                JOIN wallets ON wallets.id = accounts.wallet_id
                               WHERE ledger_entries.transaction_id = transactions.id AND wallets.user_id = $1
                                 AND accounts.currency_code = ${currency})`);
    fundingFilters.push(`funding_payments.currency_code = ${currency}`);
  }
  if (query.from) {
    const from = bind(query.from);
    transactionFilters.push(`transactions.${time} >= ${from}::timestamptz`);
    fundingFilters.push(`funding_payments.created_at >= ${from}::timestamptz`);
  }
  if (query.to) {
    const to = bind(query.to);
    transactionFilters.push(`transactions.${time} < ${to}::timestamptz`);
    fundingFilters.push(`funding_payments.created_at < ${to}::timestamptz`);
  }
  const includeFundings = !query.type || query.type === 'FUNDING';
  const rows = (await dataSource.query(
    `SELECT reference FROM (
       SELECT transactions.reference, transactions.${time} AS at, transactions.id FROM transactions
        WHERE transactions.user_id = $1 ${transactionFilters.map((filter) => `AND ${filter}`).join(' ')}
       ${
         includeFundings
           ? `UNION ALL
       SELECT 'funding:' || funding_payments.flow_id, funding_payments.created_at, funding_payments.flow_id FROM funding_payments
        WHERE funding_payments.user_id = $1 AND funding_payments.funding_transaction_id IS NULL ${fundingFilters.map((filter) => `AND ${filter}`).join(' ')}`
           : ''
       }
     ) AS everything ORDER BY at DESC, id DESC`,
    parameters,
  )) as { reference: string }[];
  return rows.map((row) => row.reference);
}


export async function userLegsByReference(
  dataSource: DataSource,
  userId: string,
): Promise<Map<string, { currency: string; minorUnit: number; direction: string; amount: string }[]>> {
  const rows = (await dataSource.query(
    `SELECT transactions.reference, ledger_entries.currency_code AS currency, currencies.minor_unit AS "minorUnit",
            ledger_entries.direction::text AS direction, ledger_entries.amount_minor::text AS amount
       FROM ledger_entries
       JOIN transactions ON transactions.id = ledger_entries.transaction_id
       JOIN accounts ON accounts.id = ledger_entries.account_id
       JOIN wallets ON wallets.id = accounts.wallet_id
       JOIN currencies ON currencies.code = ledger_entries.currency_code
      WHERE wallets.user_id = $1
      ORDER BY ledger_entries.direction, ledger_entries.id`,
    [userId],
  )) as { reference: string; currency: string; minorUnit: number; direction: string; amount: string }[];
  const legs = new Map<string, { currency: string; minorUnit: number; direction: string; amount: string }[]>();
  for (const { reference, ...leg } of rows) legs.set(reference, [...(legs.get(reference) ?? []), leg]);
  return legs;
}


export async function transactionsOnForeignAccounts(dataSource: DataSource): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT DISTINCT transactions.reference
       FROM ledger_entries
       JOIN transactions ON transactions.id = ledger_entries.transaction_id
       JOIN accounts ON accounts.id = ledger_entries.account_id
       JOIN wallets ON wallets.id = accounts.wallet_id
      WHERE transactions.user_id IS DISTINCT FROM wallets.user_id`,
  )) as { reference: string }[];
  return rows.map((row) => row.reference);
}
