import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source.options';
import { UnitOfWork } from './transaction/unit-of-work';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildDataSourceOptions(config.db, 'app'),
        autoLoadEntities: true,
        retryAttempts: 5,
        retryDelay: 1000,
      }),
    }),
  ],
  providers: [UnitOfWork],
  exports: [UnitOfWork],
})
export class DatabaseModule {}
