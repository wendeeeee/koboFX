import * as argon2 from 'argon2';
import { PASSWORD_HASHING_OPTIONS, PasswordHasher } from './password-hasher';
import { MAXIMUM_PASSWORD_LENGTH, normalizePassword, passwordProblem } from './password-policy';

describe('password policy (decision #12)', () => {
  it.each([
    ['short', 'elevenchars', 'TOO_SHORT'],
    ['12 characters', 'twelve-chars', null],
    ['counts code points, not UTF-16 units', '🔒'.repeat(11), 'TOO_SHORT'],
    ['too long', 'x1'.repeat(MAXIMUM_PASSWORD_LENGTH), 'TOO_LONG'],
    ['common', 'Password1234', 'TOO_COMMON'],
    ['single character repeated', 'aaaaaaaaaaaaaa', 'REPETITIVE'],
    ['short pattern repeated', 'abcabcabcabcabc', 'REPETITIVE'],
    ['a passphrase', 'correct horse battery', null],
    ['no composition rules', 'alllowercaseletters', null],
  ])('%s', (_label, password, problem) => {
    expect(passwordProblem(password)).toBe(problem);
  });

  it('normalises with NFKC, so visually identical input is the same password', () => {
    expect(normalizePassword('ｐａｓｓ')).toBe('pass');
    expect(normalizePassword('é')).toBe('é');
  });
});

describe('PasswordHasher (design §9.1: argon2id m=19MiB t=2 p=1)', () => {
  const hasher = new PasswordHasher();
  beforeAll(() => hasher.onModuleInit());

  it('hashes with argon2id at exactly the design parameters', async () => {
    const hash = await hasher.hash('a long enough password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hasher.needsRehash(hash)).toBe(false);
    expect(PASSWORD_HASHING_OPTIONS).toMatchObject({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
  });

  it('verifies the right password, refuses a wrong one, and matches NFKC-equivalent input', async () => {
    const hash = await hasher.hash('ｃｏｒｒｅｃｔ horse');
    await expect(hasher.verify(hash, 'correct horse')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'correct horsf')).resolves.toBe(false);
  });

  it('treats a malformed stored hash as no match rather than an error', async () => {
    await expect(hasher.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('flags hashes made with weaker parameters for rehash', async () => {
    const weak = await argon2.hash('x', { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(hasher.needsRehash(weak)).toBe(true);
  });

  it('the unknown-user path does the same argon2 work (a real verify against a same-parameter hash)', async () => {
    const verify = jest.spyOn(hasher, 'verify');
    await expect(hasher.verifyAgainstDummy('whatever password')).resolves.toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    const [dummyHash] = verify.mock.calls[0];
    expect(dummyHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });
});
