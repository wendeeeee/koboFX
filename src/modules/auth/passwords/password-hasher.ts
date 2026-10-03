import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { normalizePassword } from './password-policy';

export const PASSWORD_HASHING_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;


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
      return false;
    }
  }

  async verifyAgainstDummy(password: string): Promise<false> {
    await this.verify(this.dummyHash, password);
    return false;
  }

  needsRehash(passwordHash: string): boolean {
    return argon2.needsRehash(passwordHash, PASSWORD_HASHING_OPTIONS);
  }
}
