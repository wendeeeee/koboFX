import { Body, Controller, Get, Post } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { RequestContext } from '../../src/common/context';
import { InvariantViolationError, ResourceBusyError } from '../../src/common/errors';
import { ConfigValidationError } from '../../src/config/configuration';
import { CurrencyRegistry } from '../../src/modules/currencies/currency-registry';
import { TestDatabase, startTestDatabase } from '../support/test-database';

class ProbeDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)$/)
  amountMinor!: string;

  @IsString()
  @IsNotEmpty()
  currency!: string;
}

/** Test-only routes that drive the real pipeline through each error path. */
@Controller('probe')
class ProbeController {
  constructor(private readonly currencies: CurrencyRegistry) {}

  @Get('context')
  context(): { correlationId: string | undefined } {
    return { correlationId: RequestContext.correlationId() };
  }

  @Post('validate')
  validate(@Body() dto: ProbeDto): { currency: string; minorUnit: number; amountMinor: string } {
    const currency = this.currencies.require(dto.currency);
    return { currency: currency.code, minorUnit: currency.minorUnit, amountMinor: dto.amountMinor };
  }

  @Get('busy')
  busy(): never {
    throw new ResourceBusyError('The resource is busy. Retry the request with the same Idempotency-Key.');
  }

  @Get('bug')
  bug(): never {
    throw new InvariantViolationError('ledger unbalanced for txn 42');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('HTTP pipeline (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await startTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(db.env)],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  describe('correlation id', () => {
    it('is generated, echoed as a header, and visible to handlers via the request context', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/context').expect(200);
      const id = res.header['x-correlation-id'];
      expect(id).toMatch(UUID);
      expect(res.body).toEqual({ correlationId: id });
    });

    it('accepts a well-formed client id and propagates it', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/context')
        .set('X-Correlation-Id', 'client-trace-0001')
        .expect(200);
      expect(res.header['x-correlation-id']).toBe('client-trace-0001');
      expect(res.body.correlationId).toBe('client-trace-0001');
    });

    it('replaces a malformed client id (no log injection)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/context')
        .set('X-Correlation-Id', 'evil"} {"admin":true')
        .expect(200);
      expect(res.header['x-correlation-id']).toMatch(UUID);
    });
  });

  describe('error contract (design §12.1)', () => {
    it('404s in contract shape, carrying the same correlation id as the header', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: expect.any(String),
        correlationId: res.header['x-correlation-id'],
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    });

    it('validation failures are 400 VALIDATION_FAILED with violations; unknown fields are rejected', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .send({ amountMinor: 1000, currency: 'NGN', extra: true })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details.violations).toEqual(
        expect.arrayContaining([
          expect.stringContaining('amountMinor'),
          expect.stringContaining('extra should not exist'),
        ]),
      );
    });

    it('amounts arrive as strings; a currency outside the controlled set is UNSUPPORTED_CURRENCY', async () => {
      const ok = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .send({ amountMinor: '100000', currency: 'NGN' })
        .expect(201);
      expect(ok.body).toEqual({ currency: 'NGN', minorUnit: 2, amountMinor: '100000' });

      const bad = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .send({ amountMinor: '100', currency: 'XYZ' })
        .expect(400);
      expect(bad.body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY', details: { currency: 'XYZ' } });
    });

    it('RESOURCE_BUSY is a 503 with Retry-After', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/busy').expect(503);
      expect(res.header['retry-after']).toBe('1');
      expect(res.body.code).toBe('RESOURCE_BUSY');
    });

    it('our own bugs are a 500 that leaks nothing', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/bug').expect(500);
      expect(res.body.code).toBe('INVARIANT_VIOLATION');
      expect(JSON.stringify(res.body)).not.toContain('txn 42');
    });

    it('bodies over 100kb are refused with 413 in contract shape', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe/validate')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ amountMinor: '1', currency: 'NGN', pad: 'x'.repeat(150_000) }))
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(res.body.correlationId).toBe(res.header['x-correlation-id']);
    });
  });

  it('sets security headers (helmet)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/context');
    expect(res.header['x-content-type-options']).toBe('nosniff');
    expect(res.header['x-powered-by']).toBeUndefined();
  });

  it('refuses to build the app with an invalid environment', () => {
    expect(() => AppModule.forRoot({ NODE_ENV: 'test' })).toThrow(ConfigValidationError);
  });
});
