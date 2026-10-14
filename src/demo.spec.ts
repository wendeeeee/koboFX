import { prepareDemoEnvironment } from './demo';

describe('prepareDemoEnvironment (the single-process hosted demo)', () => {
  it("gives the platform's PORT to the UI and moves the API to 127.0.0.1:DEMO_API_PORT", () => {
    const env: Record<string, string | undefined> = { PORT: '10000' };
    expect(prepareDemoEnvironment(env)).toEqual({ publicPort: 10000, apiPort: 3000, mockPaystackPort: 4030, mockPspPort: 4010 });
    expect(env).toMatchObject({
      PORT: '3000',
      UI_PORT: '10000',
      UI_HOST: '0.0.0.0',
      UI_API_ORIGIN: 'http://127.0.0.1:3000',
      MOCK_PAYSTACK_WEBHOOK_URL: 'http://127.0.0.1:3000/api/v1/webhooks/paystack',
      MOCK_PSP_WEBHOOK_URL: 'http://127.0.0.1:3000/api/v1/webhooks/psp',
    });
    const moved: Record<string, string | undefined> = { PORT: '8080', DEMO_API_PORT: '3100' };
    prepareDemoEnvironment(moved);
    expect(moved).toMatchObject({ PORT: '3100', UI_PORT: '8080', UI_API_ORIGIN: 'http://127.0.0.1:3100' });
  });

  it("splits Render's DATABASE_URL into the owner's settings (decoded, default port) without overriding explicit ones", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://kobofx_owner:p%40ss%2Fword@dpg-abc123-a/kobofx' };
    prepareDemoEnvironment(env);
    expect(env).toMatchObject({
      DB_HOST: 'dpg-abc123-a',
      DB_PORT: '5432',
      DB_NAME: 'kobofx',
      DB_MIGRATION_USER: 'kobofx_owner',
      DB_MIGRATION_PASSWORD: 'p@ss/word',
    });
    const explicit: Record<string, string | undefined> = { DATABASE_URL: 'postgres://owner:pw@db.example.com:6543/other', DB_HOST: 'kept' };
    prepareDemoEnvironment(explicit);
    expect(explicit).toMatchObject({ DB_HOST: 'kept', DB_PORT: '6543', DB_NAME: 'other' });
    expect(() => prepareDemoEnvironment({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow('postgres://');
  });

  it("reports Render's commit as the build SHA unless BUILD_GIT_SHA is set", () => {
    const env: Record<string, string | undefined> = { RENDER_GIT_COMMIT: 'abc1234' };
    prepareDemoEnvironment(env);
    expect(env.BUILD_GIT_SHA).toBe('abc1234');
    const pinned: Record<string, string | undefined> = { RENDER_GIT_COMMIT: 'abc1234', BUILD_GIT_SHA: 'def5678' };
    prepareDemoEnvironment(pinned);
    expect(pinned.BUILD_GIT_SHA).toBe('def5678');
  });
});
