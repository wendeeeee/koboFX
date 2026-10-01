import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiInstant } from '../../openapi/properties';
import type { FxReadiness, ReadinessReport, VersionReport } from './health.controller';

/** OpenAPI documentation of the probes (Phase 11). Never instantiated. */
@ApiSchema({ name: 'Version' })
export class VersionDocument implements VersionReport {
  @ApiProperty({ example: '65b0d27', description: 'The git SHA the running build was made from (`unknown` only outside production).' })
  gitSha!: string;
}

@ApiSchema({ name: 'Liveness' })
export class LivenessDocument {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({ type: VersionDocument })
  version!: VersionDocument;
}

@ApiSchema({ name: 'ReadinessChecks' })
export class ReadinessChecksDocument {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  postgres!: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  redis!: 'up' | 'down';
}

@ApiSchema({ name: 'FxReadiness' })
export class FxReadinessDocument implements FxReadiness {
  @ApiProperty({
    enum: ['EXECUTABLE', 'DISPLAY_ONLY', 'UNSERVABLE', 'NONE', 'UNKNOWN'],
    example: 'EXECUTABLE',
    description: 'Rate freshness, REPORTED only: a cold or stale rate never fails readiness (auth, wallet and history stay up).',
  })
  tier!: FxReadiness['tier'];

  @ApiProperty({ type: 'integer', nullable: true, example: 95 })
  rateAgeSeconds!: number | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'exchange-rate-api' })
  provider!: string | null;

  @ApiInstant('The rate\'s publication time.', '2026-09-29T10:00:00.000Z', { nullable: true })
  asOf!: string | null;
}

@ApiSchema({ name: 'Readiness' })
export class ReadinessDocument implements ReadinessReport {
  @ApiProperty({ enum: ['ok', 'unavailable'], example: 'ok', description: '`unavailable` (HTTP 503) when Postgres or Redis is down.' })
  status!: 'ok' | 'unavailable';

  @ApiProperty({ type: VersionDocument })
  version!: VersionDocument;

  @ApiProperty({ type: ReadinessChecksDocument })
  checks!: ReadinessChecksDocument;

  @ApiProperty({ type: FxReadinessDocument })
  fx!: FxReadinessDocument;
}
