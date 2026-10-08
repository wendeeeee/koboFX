import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './configuration';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  /** Validates eagerly: an invalid environment throws before any provider is built. */
  static forRoot(env: Record<string, string | undefined> = process.env): DynamicModule {
    const config: AppConfig = loadConfig(env);
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
