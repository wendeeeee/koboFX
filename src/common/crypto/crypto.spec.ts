import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { canonicalParts, digestsEqual, keyedDigest, keyedDigestCandidates } from './keyed-digest';
import { KeyRing, KeyRingRule, parseKeyRing } from './key-ring';
import { open, seal, SEALED_OVERHEAD_BYTES, SealingContext } from './sealing';

const context: SealingContext = { table: 'withdrawal_beneficiaries', column: 'account_number_sealed', rowId: 'b-1', ownerId: 'u-1', provider: 'paystack' };

describe('sealing codec', () => {
  const key = randomBytes(32);

  it('round-trips any bytes and frames them as version ‖ nonce ‖ ciphertext ‖ tag', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const plaintext = Buffer.from(bytes);
        const sealed = seal(key, plaintext, context);
        return sealed[0] === 0x01 && sealed.length === plaintext.length + SEALED_OVERHEAD_BYTES && open(key, sealed, context).equals(plaintext);
      }),
    );
  });

  it('never repeats a nonce in practice: the same plaintext seals differently', () => {
    expect(seal(key, Buffer.from('0123456789'), context).equals(seal(key, Buffer.from('0123456789'), context))).toBe(false);
  });

  it.each([
    ['another row', { ...context, rowId: 'b-2' }],
    ['another column', { ...context, column: 'resolved_account_name_sealed' }],
    ['another owner', { ...context, ownerId: 'u-2' }],
    ['another table', { ...context, table: 'withdrawal_destinations' }],
  ])('refuses to open in %s (the AAD binds the location)', (_label, elsewhere) => {
    const sealed = seal(key, Buffer.from('0123456789'), context);
    expect(() => open(key, sealed, elsewhere)).toThrow(/failed authentication/);
  });

  it('refuses a wrong key, any flipped byte, a truncated value and an unknown version', () => {
    const sealed = seal(key, Buffer.from('0123456789'), context);
    expect(() => open(randomBytes(32), sealed, context)).toThrow(/failed authentication/);
    for (let index = 1; index < sealed.length; index++) {
      const tampered = Buffer.from(sealed);
      tampered[index] ^= 0x01;
      expect(() => open(key, tampered, context)).toThrow(/failed authentication/);
    }
    expect(() => open(key, sealed.subarray(0, SEALED_OVERHEAD_BYTES - 1), context)).toThrow(/known codec version/);
    const versioned = Buffer.from(sealed);
    versioned[0] = 0x02;
    expect(() => open(key, versioned, context)).toThrow(/known codec version/);
    expect(() => seal(randomBytes(16), Buffer.from('x'), context)).toThrow(/exactly 32 bytes/);
    expect(() => seal(key, Buffer.from('x'), { ...context, rowId: 'a|b' })).toThrow(/free of "\|"/);
  });
});

describe('keyed digests', () => {
  const ring: KeyRing = { activeKeyId: 'k2', keys: new Map([['k1', randomBytes(32)], ['k2', randomBytes(32)]]) };

  it('length-prefixes parts so shifted boundaries never collide', () => {
    expect(canonicalParts('d', ['ab', 'c']).equals(canonicalParts('d', ['a', 'bc']))).toBe(false);
    const a = keyedDigest(ring, 'd', ['ab', 'c']);
    const b = keyedDigest(ring, 'd', ['a', 'bc']);
    expect(digestsEqual(a.digest, b.digest)).toBe(false);
  });

  it('is keyed: another key or domain gives another digest; candidates cover every key, active first', () => {
    const parts = ['user', '058', '0123456789', 'nuban', 'NGN'];
    const active = keyedDigest(ring, 'd', parts);
    expect(active.keyId).toBe('k2');
    expect(digestsEqual(active.digest, keyedDigest(ring, 'd', parts, 'k1').digest)).toBe(false);
    expect(digestsEqual(active.digest, keyedDigest(ring, 'e', parts).digest)).toBe(false);
    expect(keyedDigestCandidates(ring, 'd', parts).map((candidate) => candidate.keyId)).toEqual(['k2', 'k1']);
    expect(() => keyedDigest(ring, 'd', parts, 'k9')).toThrow(/No such key/);
  });
});

describe('parseKeyRing', () => {
  const rule: KeyRingRule = { name: 'KEYS', activeName: 'ACTIVE', exactBytes: 32 };
  const parse = (json: string | undefined, active: string | undefined, override: KeyRingRule = rule) => {
    const problems: string[] = [];
    return { ring: parseKeyRing(json, active, override, problems), problems };
  };
  const material = randomBytes(32).toString('base64');

  it('absent is null (not configured); present is a ring with the active key', () => {
    expect(parse(undefined, undefined).ring).toBeNull();
    const { ring, problems } = parse(JSON.stringify({ 'kek-2026-10': material }), 'kek-2026-10');
    expect(problems).toEqual([]);
    expect(ring?.activeKeyId).toBe('kek-2026-10');
    expect(ring?.keys.get('kek-2026-10')?.length).toBe(32);
  });

  it.each([
    [JSON.stringify({ a: material }), undefined, /must be set together/],
    ['nope', 'a', /must be JSON/],
    ['{}', 'a', /at least one key/],
    [JSON.stringify({ 'bad id!': material }), 'bad id!', /needs an id/],
    [JSON.stringify({ a: randomBytes(16).toString('base64') }), 'a', /exactly 32 bytes/],
    [JSON.stringify({ a: material }), 'b', /is not a key in KEYS/],
  ])('refuses %s / %s', (json, active, pattern) => {
    const { ring, problems } = parse(json, active);
    expect(ring).toBeUndefined();
    expect(problems.join('\n')).toMatch(pattern);
  });

  it('enforces a minimum for HMAC keys', () => {
    const { problems } = parse(JSON.stringify({ h: randomBytes(16).toString('base64') }), 'h', { name: 'H', activeName: 'HA', minimumBytes: 32 });
    expect(problems.join('\n')).toMatch(/at least 32 bytes/);
  });
});
