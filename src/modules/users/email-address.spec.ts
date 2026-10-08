import fc from 'fast-check';
import { isDisposableEmailAddress, isSupportedEmailAddress, normalizeEmailAddress } from './email-address';

const localPart = fc.stringMatching(/^[a-z0-9][a-z0-9._+-]{0,20}[a-z0-9]$/).filter((part) => !part.includes('..'));
const domain = fc
  .tuple(fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/), fc.constantFrom('com', 'org', 'ng', 'co.uk', 'io'))
  .map(([label, tld]) => `${label}.${tld}`);
const asciiEmail = fc.tuple(localPart, domain).map(([local, host]) => `${local}@${host}`);
const randomCasing = (email: string) =>
  fc.array(fc.boolean(), { minLength: email.length, maxLength: email.length }).map((flags) =>
    [...email].map((character, index) => (flags[index] ? character.toUpperCase() : character)).join(''),
  );

/** Characters that look like ASCII letters but are not. */
const LOOKALIKES = ['а', 'е', 'о', 'р', 'с', 'х', 'К', 'ı', 'ſ', 'ｅ', 'ⅿ', 'ß'];

describe('email normalisation (the uniqueness rule)', () => {
  it('any casing and surrounding whitespace of an ASCII address normalises to one value', () => {
    fc.assert(
      fc.property(
        asciiEmail.chain((email) => fc.tuple(fc.constant(email), randomCasing(email), fc.constantFrom('', ' ', '\t'))),
        ([email, cased, padding]) => {
          const normalized = normalizeEmailAddress(`${padding}${cased}${padding}`);
          expect(normalized).toBe(email);
          expect(isSupportedEmailAddress(normalized)).toBe(true);
        },
      ),
    );
  });

  it('refuses any address containing a non-ASCII lookalike — never folds it onto an ASCII one', () => {
    fc.assert(
      fc.property(asciiEmail, fc.constantFrom(...LOOKALIKES), fc.nat(), (email, lookalike, position) => {
        const index = position % email.length;
        const spoofed = `${email.slice(0, index)}${lookalike}${email.slice(index + 1)}`;
        expect(isSupportedEmailAddress(normalizeEmailAddress(spoofed))).toBe(false);
      }),
    );
    // The Kelvin sign lowercases to an ASCII "k": it must be refused, not mapped.
    expect(normalizeEmailAddress('Kelvin@example.com')).not.toBe('kelvin@example.com');
    expect(isSupportedEmailAddress(normalizeEmailAddress('Kelvin@example.com'))).toBe(false);
  });

  it('keeps provider-specific variants distinct (dots and +tags are different mailboxes to SMTP)', () => {
    expect(normalizeEmailAddress('first.last+fx@gmail.com')).toBe('first.last+fx@gmail.com');
    expect(normalizeEmailAddress('firstlast@gmail.com')).not.toBe(normalizeEmailAddress('first.last@gmail.com'));
  });

  it.each([
    ['plain', 'user@example.com', true],
    ['subdomain', 'user@mail.example.co.uk', true],
    ['no at', 'user.example.com', false],
    ['two ats', 'a@b@example.com', false],
    ['leading dot', '.user@example.com', false],
    ['double dot', 'us..er@example.com', false],
    ['no tld', 'user@localhost', false],
    ['numeric tld', 'user@example.123', false],
    ['uppercase (not normalised)', 'User@example.com', false],
    ['space', 'us er@example.com', false],
    ['hyphen-edged label', 'user@-example.com', false],
    ['local part > 64', `${'a'.repeat(65)}@example.com`, false],
    ['address > 254', `a@${'b'.repeat(250)}.com`, false],
  ])('%s: %s → %s', (_label, email, supported) => {
    expect(isSupportedEmailAddress(email)).toBe(supported);
  });

  it('flags disposable domains and their subdomains, not ordinary ones', () => {
    expect(isDisposableEmailAddress('x@mailinator.com')).toBe(true);
    expect(isDisposableEmailAddress('x@eu.mailinator.com')).toBe(true);
    expect(isDisposableEmailAddress('x@example.com')).toBe(false);
    expect(isDisposableEmailAddress('x@gmail.com')).toBe(false);
  });
});
