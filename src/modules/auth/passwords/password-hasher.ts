import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { normalizePassword } from './password-policy';

/** design §9.1: argon2id, m = 19 MiB, t = 2, p = 1 (the OWASP baseline). */
export const PASSWORD_HASHING_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Password hashing. Passwords are NFKC-normalised first, so the same password typed on
 * different keyboards or platforms hashes the same (NIST 800-63B).
 *
 * `verifyAgainstDummy` exists for enumeration resistance: when the email is unknown we
 * still run one full argon2 verification, against a dummy hash made with the same
 * parameters, so "no such user" costs the same as "wrong password".
 */
@Injectable()
export class PasswordHasher implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(32).toString('base64'));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(normalizePassword(password), PASSWORD_HASHING_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, normalizePassword(password));
    } catch {
      // A malformed stored hash is never a match. (The table's CHECK makes it unlikely.)
      return false;
    }
  }

  /** Same work as `verify`; always false. */
  async verifyAgainstDummy(password: string): Promise<false> {
    await this.verify(this.dummyHash, password);
    return false;
  }

  /** Whether a stored hash predates the current parameters and should be re-hashed on login. */
  needsRehash(passwordHash: string): boolean {
    return argon2.needsRehash(passwordHash, PASSWORD_HASHING_OPTIONS);
  }
}
