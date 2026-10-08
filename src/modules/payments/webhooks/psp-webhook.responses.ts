import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({ name: 'WebhookReceived' })
export class WebhookReceivedDocument {
  @ApiProperty({ enum: [true], example: true, description: 'Durably stored; processed asynchronously.' })
  received!: true;
}


export const PSP_WEBHOOK_BODY_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true,
  description:
    'The PSP\'s event, verified over the RAW bytes (do not re-serialise). Only `id`, `type` and `data.object.id` are read; ' +
    'the event is a hint — the PSP\'s API is asked for the authoritative state.',
  properties: {
    id: { type: 'string' as const, maxLength: 128, example: 'evt_1a2b3c4d' },
    type: { type: 'string' as const, maxLength: 64, example: 'payment.captured' },
    data: {
      type: 'object' as const,
      properties: { object: { type: 'object' as const, properties: { id: { type: 'string' as const, maxLength: 128, example: 'pay_8f7e6d5c4b3a' } } } },
    },
  },
};
