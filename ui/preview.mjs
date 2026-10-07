import { estimateTarget, scaleOf } from './money.mjs';

/** Explicit, isolated sample experience. No preview action ever calls the backend. */
export function createPreview() {
  const balances = [{ currency: 'NGN', minorUnit: 2, total: '32500000', available: '32500000', reserved: '0' }, { currency: 'USD', minorUnit: 2, total: '24000', available: '24000', reserved: '0' }, { currency: 'EUR', minorUnit: 2, total: '8500', available: '8500', reserved: '0' }, { currency: 'GBP', minorUnit: 2, total: '0', available: '0', reserved: '0' }];
  const now = () => new Date().toISOString();
  const pairs = [
    ['USD', 'NGN', '1580.27'], ['EUR', 'NGN', '1754.32'], ['GBP', 'NGN', '2070.81'],
    ['NGN', 'USD', '0.000623'], ['NGN', 'EUR', '0.000561'], ['NGN', 'GBP', '0.000475'],
    ['USD', 'EUR', '0.89'], ['EUR', 'USD', '1.10'], ['USD', 'GBP', '0.75'], ['GBP', 'USD', '1.31'],
    ['EUR', 'GBP', '0.84'], ['GBP', 'EUR', '1.17'],
  ].map(([from, to, clientRate]) => ({ from, to, clientRate, midRate: clientRate, spreadBasisPoints: 150, minimumSourceAmount: '100' }));
  const items = [
    { reference: 'preview-funding', type: 'FUNDING', status: 'COMPLETED', valueTime: new Date(Date.now() - 3600000).toISOString(), legs: [{ currency: 'NGN', minorUnit: 2, direction: 'CREDIT', amount: '5000000' }] },
    { reference: 'preview-exchange', type: 'CONVERSION', status: 'COMPLETED', valueTime: new Date(Date.now() - 86400000).toISOString(), legs: [{ currency: 'NGN', minorUnit: 2, direction: 'DEBIT', amount: '15800000' }, { currency: 'USD', minorUnit: 2, direction: 'CREDIT', amount: '10000' }] },
    { reference: 'preview-opening', type: 'FUNDING', status: 'COMPLETED', valueTime: new Date(Date.now() - 172800000).toISOString(), legs: [{ currency: 'NGN', minorUnit: 2, direction: 'CREDIT', amount: '20000000' }] },
  ];
  const quotes = new Map();
  const replay = new Map();
  const banks = [{ bankCode: '044', bankName: 'Access Bank', currency: 'NGN' }, { bankCode: '058', bankName: 'Guaranty Trust Bank', currency: 'NGN' }, { bankCode: '033', bankName: 'United Bank for Africa', currency: 'NGN' }];
  const beneficiaries = [{ beneficiaryId: 'preview-beneficiary', status: 'READY', bankCode: '058', bankName: 'Guaranty Trust Bank', currency: 'NGN', accountNumberMasked: '******6789', accountName: 'ADA LOVELACE', failureCode: null, reviewRequired: false, createdAt: now() }];
  const receipts = [];
  const withdrawals = new Map();
  return {
    user: { id: 'preview', email: 'ada@example.com', status: 'ACTIVE', verifiedAt: now() },
    async request(path, options = {}) {
      const { body, key } = options;
      if (key && replay.has(key)) return replay.get(key);
      let result;
      if (path === '/wallet') return { balances: structuredClone(balances) };
      if (path === '/fx/rates') return { pairs, stale: false, asOf: now(), attribution: null };
      if (path.startsWith('/transactions/')) return { ...items.find((item) => item.reference === decodeURIComponent(path.split('/').pop())), initiatedBy: 'USER' };
      if (path.startsWith('/transactions')) {
        const filter = new URLSearchParams(path.split('?')[1]).get('type');
        return { items: structuredClone(items.filter((item) => !filter || item.type === filter)), nextCursor: null };
      }
      const method = options.method || 'GET';
      if (method === 'GET' && path.startsWith('/wallet/withdrawal-banks')) return { items: structuredClone(banks), nextCursor: null, asOf: now() };
      if (method === 'GET' && path.startsWith('/wallet/withdrawal-beneficiaries')) return { items: structuredClone(beneficiaries), nextCursor: null };
      if (method === 'GET' && path === '/stash') {
        const amount = receipts.reduce((sum, receipt) => sum + (receipt.direction === 'IN' ? 1n : -1n) * BigInt(receipt.amount), 0n);
        return { stashId: receipts.length ? 'preview-stash' : null, kind: 'SIMULATED_BANK', simulated: true, balances: [{ currency: 'NGN', minorUnit: 2, amount: amount.toString() }] };
      }
      if (method === 'GET' && path.startsWith('/stash/transactions')) return { stashId: receipts.length ? 'preview-stash' : null, kind: 'SIMULATED_BANK', simulated: true, items: structuredClone(receipts), nextCursor: null };
      if (method === 'GET' && path.startsWith('/wallet/withdraw/')) return structuredClone(withdrawals.get(decodeURIComponent(path.split('/').pop())));
      if (path === '/wallet/withdraw/one-time-password') return { status: 'REQUESTED', channel: 'EMAIL', expiresInSeconds: 600 };
      if (path === '/wallet/withdrawal-beneficiaries') {
        const bank = banks.find((entry) => entry.bankCode === body.bankCode) || banks[0];
        const added = { beneficiaryId: crypto.randomUUID(), status: 'READY', bankCode: bank.bankCode, bankName: bank.bankName, currency: 'NGN', accountNumberMasked: `******${body.accountNumber.slice(-4)}`, accountName: 'ADA LOVELACE', failureCode: null, reviewRequired: false, createdAt: now() };
        beneficiaries.unshift(added);
        result = { beneficiaryId: added.beneficiaryId, status: 'READY' };
      } else if (path === '/wallet/withdraw/paystack') {
        const beneficiary = beneficiaries.find((entry) => entry.beneficiaryId === body.beneficiaryId);
        const balance = balances.find((entry) => entry.currency === 'NGN');
        if (BigInt(balance.available) < BigInt(body.amount)) throw new Error('That’s more than your available naira. Enter a smaller amount.');
        balance.total = balance.available = (BigInt(balance.total) - BigInt(body.amount)).toString();
        const withdrawalId = crypto.randomUUID();
        const destination = { bankCode: beneficiary.bankCode, bankName: beneficiary.bankName, accountNumberMasked: beneficiary.accountNumberMasked, accountName: beneficiary.accountName };
        withdrawals.set(withdrawalId, { withdrawalId, status: 'COMPLETED', amount: body.amount, currency: 'NGN', minorUnit: 2, fee: '0', totalDebit: body.amount, destination, transactionReference: `withdrawal:${withdrawalId}`, stashReceiptId: null, failureCode: null, reviewRequired: false, provider: 'paystack', simulated: true });
        receipts.unshift({ receiptId: crypto.randomUUID(), kind: 'CONFIRMATION', direction: 'IN', currency: 'NGN', minorUnit: 2, amount: body.amount, withdrawalId, destination, recordedAt: now(), valueTime: now() });
        items.unshift({ reference: `withdrawal:${withdrawalId}`, type: 'WITHDRAWAL', status: 'COMPLETED', valueTime: now(), legs: [{ currency: 'NGN', amount: body.amount, direction: 'DEBIT', minorUnit: 2 }] });
        result = { withdrawalId, status: 'PENDING', amount: body.amount, currency: 'NGN', fee: '0', totalDebit: body.amount, provider: 'paystack', simulated: true };
      } else if (path === '/fx/quotes') {
        const rate = pairs.find((pair) => pair.from === body.from && pair.to === body.to);
        if (!rate) throw new Error('Choose a different currency pair.');
        result = { ...body, quoteId: crypto.randomUUID(), targetAmount: estimateTarget(body.sourceAmount, rate.clientRate, scaleOf(body.from), scaleOf(body.to)), clientRate: rate.clientRate, expiresAt: new Date(Date.now() + 30000).toISOString(), status: 'OPEN', spreadBasisPoints: 150 };
        quotes.set(result.quoteId, result);
      } else if (path === '/wallet/trade') {
        const quote = quotes.get(body.quoteId);
        if (!quote || Date.now() >= Date.parse(quote.expiresAt)) throw new Error('This quote has expired. Get a fresh quote.');
        if (quote.status !== 'OPEN') throw new Error('This exchange has already been completed.');
        const source = balances.find((balance) => balance.currency === quote.from);
        const target = balances.find((balance) => balance.currency === quote.to);
        if (BigInt(source.available) < BigInt(quote.sourceAmount)) throw new Error('Add money or enter a smaller amount to make this exchange.');
        source.total = source.available = (BigInt(source.total) - BigInt(quote.sourceAmount)).toString();
        target.total = target.available = (BigInt(target.total) + BigInt(quote.targetAmount)).toString();
        quote.status = 'CONSUMED';
        result = { reference: `conversion:${quote.quoteId}`, type: 'CONVERSION', status: 'COMPLETED', valueTime: now(), legs: [{ currency: quote.from, amount: quote.sourceAmount, direction: 'DEBIT', minorUnit: scaleOf(quote.from) }, { currency: quote.to, amount: quote.targetAmount, direction: 'CREDIT', minorUnit: scaleOf(quote.to) }] };
        items.unshift(result);
      } else if (path === '/wallet/fund/paystack') {
        const balance = balances.find((entry) => entry.currency === body.currency);
        balance.total = balance.available = (BigInt(balance.total) + BigInt(body.amount)).toString();
        result = { fundingId: crypto.randomUUID(), amount: body.amount, currency: body.currency, status: 'COMPLETED', checkout: null };
        items.unshift({ reference: `funding:${result.fundingId}`, type: 'FUNDING', status: 'COMPLETED', valueTime: now(), legs: [{ currency: body.currency, amount: body.amount, direction: 'CREDIT', minorUnit: scaleOf(body.currency) }] });
      } else throw new Error('This action is not part of the preview.');
      if (key) replay.set(key, result);
      return result;
    },
  };
}
