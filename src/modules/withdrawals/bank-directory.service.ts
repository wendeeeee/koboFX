import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DependencyUnavailableError } from '../../common/errors';
import { PaystackTransfersGateway } from '../payments/paystack/transfers/paystack-transfers.port';
import { InvalidCursorError } from '../transactions/transactions.errors';
import { WithdrawalAdmissionGate } from './withdrawal-admission-gate';
import { WITHDRAWAL_CURRENCY } from './withdrawal-records';

export interface DirectoryBank {
  readonly bankCode: string;
  readonly bankName: string;
  readonly currency: string;
}

export interface BankDirectoryPage {
  readonly items: readonly DirectoryBank[];
  readonly nextCursor: string | null;
  readonly asOf: string;
}

interface Snapshot {
  readonly id: string;
  readonly fetchedAt: Date;
  readonly banks: readonly DirectoryBank[];
}

const FRESH_MILLISECONDS = 5 * 60_000;
const MAXIMUM_PROVIDER_PAGES = 50;
const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 100;

/**
 * Nigerian NGN `nuban` banks for withdrawals (WITHDRAWAL_PLAN.md §J): read from Paystack's paginated `/bank` into a
 * per-process snapshot (fresh for 5 minutes, refreshes single-flighted), so provider calls never scale with requests.
 * A snapshot is only kept when EVERY page was read (a repeated cursor or the page cap is an incomplete directory —
 * an error, never a shorter list). Our cursor binds the snapshot it pages through. A failed refresh keeps serving the
 * previous complete snapshot, with its real `asOf`; with none, the answer is `503`. The selected bank is still
 * resolved authoritatively by the worker — this list certifies nothing.
 */
@Injectable()
export class BankDirectoryService {
  private readonly logger = new Logger(BankDirectoryService.name);
  private snapshot: Snapshot | undefined;
  private refreshing: Promise<Snapshot> | undefined;

  constructor(
    private readonly gateway: PaystackTransfersGateway,
    private readonly gate: WithdrawalAdmissionGate,
  ) {}

  async page(currency: string, cursor: string | undefined, limit = DEFAULT_LIMIT): Promise<BankDirectoryPage> {
    await this.gate.assertOpen();
    if (currency !== WITHDRAWAL_CURRENCY) return { items: [], nextCursor: null, asOf: new Date().toISOString() };
    const size = Math.min(Math.max(1, limit), MAXIMUM_LIMIT);
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    const snapshot = position ? this.pinned(position.snapshotId) : await this.current();
    const offset = position?.offset ?? 0;
    const items = snapshot.banks.slice(offset, offset + size);
    const next = offset + items.length;
    return {
      items,
      nextCursor: next < snapshot.banks.length ? encodeCursor(snapshot.id, next) : null,
      asOf: snapshot.fetchedAt.toISOString(),
    };
  }

  /** The cached name of a bank code, without calling Paystack (null when unknown). */
  cachedName(bankCode: string): string | null {
    return this.snapshot?.banks.find((bank) => bank.bankCode === bankCode)?.bankName ?? null;
  }

  private pinned(snapshotId: string): Snapshot {
    if (this.snapshot?.id !== snapshotId) throw new InvalidCursorError('the bank directory changed since this cursor was issued');
    return this.snapshot;
  }

  private async current(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - this.snapshot.fetchedAt.getTime() < FRESH_MILLISECONDS) return this.snapshot;
    try {
      this.refreshing ??= this.fetch().finally(() => {
        this.refreshing = undefined;
      });
      this.snapshot = await this.refreshing;
    } catch (error) {
      if (!this.snapshot) {
        throw new DependencyUnavailableError('The bank directory is unavailable right now.', { dependency: 'paystack-banks' }, { cause: error });
      }
      this.logger.warn({ err: error, asOf: this.snapshot.fetchedAt.toISOString() }, 'Bank directory refresh failed; serving the previous complete snapshot');
    }
    return this.snapshot;
  }

  private async fetch(): Promise<Snapshot> {
    const banks: DirectoryBank[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PROVIDER_PAGES; page += 1) {
      const { value } = await this.gateway.listBanks({ currency: WITHDRAWAL_CURRENCY, cursor });
      for (const bank of value.items) {
        if (bank.active && !bank.isDeleted && bank.currency === WITHDRAWAL_CURRENCY && bank.type === 'nuban' && !banks.some((each) => each.bankCode === bank.code)) {
          banks.push({ bankCode: bank.code, bankName: bank.name, currency: WITHDRAWAL_CURRENCY });
        }
      }
      if (!value.nextCursor) return { id: randomUUID(), fetchedAt: new Date(), banks };
      if (seenCursors.has(value.nextCursor)) throw new DependencyUnavailableError('Paystack repeated a bank directory cursor.', { dependency: 'paystack-banks' });
      seenCursors.add(value.nextCursor);
      cursor = value.nextCursor;
    }
    throw new DependencyUnavailableError('The Paystack bank directory exceeded the page cap; not certified complete.', { dependency: 'paystack-banks' });
  }
}

function encodeCursor(snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, s: snapshotId, o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { snapshotId: string; offset: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; s?: unknown; o?: unknown };
    if (parsed.v === 1 && typeof parsed.s === 'string' && Number.isSafeInteger(parsed.o) && (parsed.o as number) >= 0) {
      return { snapshotId: parsed.s, offset: parsed.o as number };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError('malformed bank directory cursor');
}
