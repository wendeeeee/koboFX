import { Dec } from '../../common/money';
import { PricedCurrency, QuoteAmountMode, displayRate } from '../fx/pricing';

/** One leg of a conversion on the wire: a string of minor units, with the currency's scale. */
export interface ConversionLegView {
  readonly currency: string;
  readonly minorUnit: number;
  readonly amount: string;
}

/**
 * `201` body of `POST /wallet/convert` and `POST /wallet/trade`. Stored by the idempotency
 * barrier and replayed byte for byte, even after the rate moves. Amounts are authoritative
 * (minor-unit strings); rates are display strings (12 significant digits). Revenue and mid
 * value stay internal, as on quotes.
 */
export interface ConversionView {
  readonly transactionId: string;
  readonly reference: string;
  readonly type: 'CONVERSION';
  readonly status: 'POSTED';
  readonly quoteId: string | null;
  readonly amountMode: QuoteAmountMode;
  readonly debited: ConversionLegView;
  readonly credited: ConversionLegView;
  readonly rateDisplay: string;
  readonly clientRate: string;
  readonly midRate: string;
  readonly spreadBasisPoints: number;
  readonly rate: { readonly provider: string; readonly asOf: string; readonly fetchedAt: string; readonly snapshotId: string };
  readonly valueTime: string;
  readonly bookingTime: string;
}

export interface ConversionViewInput {
  readonly transactionId: string;
  readonly reference: string;
  readonly quoteId: string | null;
  readonly amountMode: QuoteAmountMode;
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  readonly sourceAmountMinor: bigint;
  readonly targetAmountMinor: bigint;
  readonly rateDisplay: string;
  readonly clientRate: Dec;
  readonly midRate: Dec;
  readonly spreadBasisPoints: number;
  readonly rateProvider: string;
  readonly rateProviderUpdatedAt: Date;
  readonly rateFetchedAt: Date;
  readonly rateSnapshotId: string;
  readonly valueTime: Date;
  readonly bookingTime: Date;
}

export function conversionView(input: ConversionViewInput): ConversionView {
  return {
    transactionId: input.transactionId,
    reference: input.reference,
    type: 'CONVERSION',
    status: 'POSTED',
    quoteId: input.quoteId,
    amountMode: input.amountMode,
    debited: { currency: input.source.code, minorUnit: input.source.minorUnit, amount: input.sourceAmountMinor.toString() },
    credited: { currency: input.target.code, minorUnit: input.target.minorUnit, amount: input.targetAmountMinor.toString() },
    rateDisplay: input.rateDisplay,
    clientRate: displayRate(input.clientRate),
    midRate: displayRate(input.midRate),
    spreadBasisPoints: input.spreadBasisPoints,
    rate: {
      provider: input.rateProvider,
      asOf: input.rateProviderUpdatedAt.toISOString(),
      fetchedAt: input.rateFetchedAt.toISOString(),
      snapshotId: input.rateSnapshotId,
    },
    valueTime: input.valueTime.toISOString(),
    bookingTime: input.bookingTime.toISOString(),
  };
}
