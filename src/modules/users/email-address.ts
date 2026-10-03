import disposableEmailDomainList from './data/disposable-email-domains.json';


export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  return isAscii(trimmed) ? trimmed.toLowerCase() : trimmed;
}

const MAXIMUM_ADDRESS_LENGTH = 254;
const MAXIMUM_LOCAL_PART_LENGTH = 64;
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isSupportedEmailAddress(normalized: string): boolean {
  if (!isAscii(normalized) || normalized !== normalized.toLowerCase()) return false;
  if (normalized.length > MAXIMUM_ADDRESS_LENGTH) return false;
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || normalized.indexOf('@') !== at) return false;
  const localPart = normalized.slice(0, at);
  const labels = normalized.slice(at + 1).split('.');
  return (
    localPart.length <= MAXIMUM_LOCAL_PART_LENGTH &&
    LOCAL_PART.test(localPart) &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label)) &&
    /^[a-z]{2,}$/.test(labels[labels.length - 1])
  );
}

const disposableDomains: ReadonlySet<string> = new Set(disposableEmailDomainList as string[]);

export function isDisposableEmailAddress(normalized: string): boolean {
  const labels = normalized.slice(normalized.lastIndexOf('@') + 1).split('.');
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (disposableDomains.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}
