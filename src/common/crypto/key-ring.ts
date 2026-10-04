/**
 * A versioned set of secret keys from configuration (WITHDRAWAL_PLAN.md §H): `keysJson` maps a key id to base64 key
 * material; `activeKeyId` names the one new data is protected with. Retired keys stay in the ring so older facts stay
 * readable (and old fingerprints findable) until every row is rewrapped or re-derived.
 *
 * Both absent → `null` (the feature that needs the ring reports an explicit dependency error when used; there is never
 * a plaintext or unkeyed fallback). One without the other, a malformed id, or key material of the wrong length is a
 * configuration problem and the process does not boot.
 */
export interface KeyRing {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface KeyRingRule {
  /** The environment variable naming the key map, for messages. */
  readonly name: string;
  /** The environment variable naming the active key id, for messages. */
  readonly activeName: string;
  /** Exact key length in bytes (an AES-256 key) … */
  readonly exactBytes?: number;
  /** … or a minimum (an HMAC key). */
  readonly minimumBytes?: number;
}

export const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function parseKeyRing(
  keysJson: string | undefined,
  activeKeyId: string | undefined,
  rule: KeyRingRule,
  problems: string[],
): KeyRing | null | undefined {
  if (keysJson === undefined && activeKeyId === undefined) return null;
  if (keysJson === undefined || activeKeyId === undefined) {
    problems.push(`${rule.name} and ${rule.activeName} must be set together`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    problems.push(`${rule.name} must be JSON mapping key id to base64 key material`);
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    problems.push(`${rule.name} must map at least one key id to base64 key material`);
    return undefined;
  }
  const keys = new Map<string, Buffer>();
  let valid = true;
  for (const [keyId, material] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof material !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(material)) {
      problems.push(`${rule.name}: key ${keyId} needs an id of [A-Za-z0-9._:-]{1,64} and base64 material`);
      valid = false;
      continue;
    }
    const key = Buffer.from(material, 'base64');
    if ((rule.exactBytes !== undefined && key.length !== rule.exactBytes) || (rule.minimumBytes !== undefined && key.length < rule.minimumBytes)) {
      problems.push(
        `${rule.name}: key ${keyId} must decode to ${rule.exactBytes !== undefined ? `exactly ${rule.exactBytes}` : `at least ${rule.minimumBytes}`} bytes`,
      );
      valid = false;
      continue;
    }
    keys.set(keyId, key);
  }
  if (valid && !keys.has(activeKeyId)) {
    problems.push(`${rule.activeName} (${activeKeyId}) is not a key in ${rule.name}`);
    valid = false;
  }
  return valid ? { activeKeyId, keys } : undefined;
}
