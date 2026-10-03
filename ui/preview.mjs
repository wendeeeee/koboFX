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
      if (path === '/fx/quotes') {
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
