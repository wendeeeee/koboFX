import { Injectable } from '@nestjs/common';

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
