export function scaleOf(currency, balances = []) {
  return balances.find((balance) => balance.currency === currency)?.minorUnit
    ?? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export function toMinor(input, scale = 2) {
  const value = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Enter an amount using digits and a decimal point.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error(`Use no more than ${scale} decimal places.`);
  const minor = BigInt(whole + fraction.padEnd(scale, '0'));
  if (minor <= 0n) throw new Error('Enter an amount greater than zero.');
  if (minor > 999999999999999999n) throw new Error('That amount is too large.');
  return minor.toString();
}

export function decimalAmount(minor, scale = 2) {
  const integer = BigInt(minor);
  const digits = (integer < 0n ? -integer : integer).toString().padStart(scale + 1, '0');
  return `${integer < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

export function formatMoney(minor, currency = 'NGN', scale = 2) {
  const raw = decimalAmount(minor, scale);
  const [whole, fraction] = raw.split('.');
  const symbols = { NGN: '₦', USD: '$', EUR: '€', GBP: '£' };
  return `${symbols[currency] || `${currency} `}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction !== undefined ? `.${fraction}` : ''}`;
}

/** Display estimate only. Execution always uses the server quote's locked amounts. */
export function estimateTarget(sourceMinor, rate, sourceScale, targetScale) {
  if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error('The exchange rate is unavailable.');
  const [whole, fraction = ''] = rate.split('.');
  return (BigInt(sourceMinor) * BigInt(whole + fraction) * 10n ** BigInt(targetScale)
    / (10n ** BigInt(fraction.length) * 10n ** BigInt(sourceScale))).toString();
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
