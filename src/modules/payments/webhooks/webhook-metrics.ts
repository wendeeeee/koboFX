import { Injectable } from '@nestjs/common';

/**
 * `webhook_signature_invalid_total` (design §10): per-process counter. A burst is a
 * security signal (someone is forging deliveries, or our secret is out of sync with the
 * PSP's). The rows themselves are kept in `webhook_events`. No metrics backend yet.
 */
@Injectable()
export class WebhookMetrics {
  private signatureInvalid = 0;

  get webhookSignatureInvalidTotal(): number {
    return this.signatureInvalid;
  }

  recordInvalidSignature(): void {
    this.signatureInvalid += 1;
  }
}
