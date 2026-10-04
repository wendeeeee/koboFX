import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { KeyedDigest, keyedDigest, keyedDigestCandidates } from '../../common/crypto/keyed-digest';
import { KeyRing } from '../../common/crypto/key-ring';
import { open, seal, SealingContext } from '../../common/crypto/sealing';
import { DependencyUnavailableError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { DataKeyStore } from './data-key.store';

export interface SealedValue {
  readonly keyId: string;
  readonly sealed: Buffer;
}

/** The identity a destination fingerprint covers (§H): owner, bank, FULL account number, recipient type, currency. */
export interface DestinationIdentity {
  readonly userId: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly recipientType: string;
  readonly currency: string;
}

const DESTINATION_DOMAIN = 'withdrawal-destination-v1';

/**
 * Sealing and keyed digests over the configured key rings (WITHDRAWAL_PLAN.md §H; D6). Plaintext exists only in
 * memory; every value is sealed under the owner's (or the evidence) data key with its storage location as AAD.
 */
@Injectable()
export class ProtectionService {
  constructor(
    private readonly dataKeys: DataKeyStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sealForUser(userId: string, plaintext: string | Buffer, context: SealingContext): Promise<SealedValue> {
    const key = await this.dataKeys.forUser(userId);
    return { keyId: key.id, sealed: seal(key.key, toBuffer(plaintext), context) };
  }

  async sealEvidence(plaintext: Buffer, context: SealingContext): Promise<SealedValue> {
    const key = await this.dataKeys.forEvidence();
    return { keyId: key.id, sealed: seal(key.key, plaintext, context) };
  }

  async open(value: SealedValue, context: SealingContext): Promise<Buffer> {
    const key = await this.dataKeys.byId(value.keyId);
    return open(key.key, value.sealed, context);
  }

  destinationFingerprint(identity: DestinationIdentity): KeyedDigest {
    return keyedDigest(this.fingerprintRing(), DESTINATION_DOMAIN, destinationParts(identity));
  }

  /** Every key version's fingerprint, active first — what a dedupe lookup searches during rotation. */
  destinationFingerprintCandidates(identity: DestinationIdentity): KeyedDigest[] {
    return keyedDigestCandidates(this.fingerprintRing(), DESTINATION_DOMAIN, destinationParts(identity));
  }

  /** The digest under one named key version (to recompute what a stored fingerprint says). */
  destinationFingerprintWith(identity: DestinationIdentity, keyId: string): KeyedDigest {
    return keyedDigest(this.fingerprintRing(), DESTINATION_DOMAIN, destinationParts(identity), keyId);
  }

  private fingerprintRing(): KeyRing {
    const ring = this.config.protection.fingerprint;
    if (!ring) {
      throw new DependencyUnavailableError('Destination fingerprints need WITHDRAWAL_FINGERPRINT_KEYS, which is not configured.', {
        dependency: 'fingerprint-keys',
      });
    }
    return ring;
  }
}

function destinationParts(identity: DestinationIdentity): string[] {
  return [identity.userId.toLowerCase(), identity.bankCode, identity.accountNumber, identity.recipientType, identity.currency];
}

function toBuffer(value: string | Buffer): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

export function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}
