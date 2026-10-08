import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CurrencyEntity } from './currency.entity';
import { CurrencyRegistry } from './currency-registry';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([CurrencyEntity])],
  providers: [CurrencyRegistry],
  exports: [CurrencyRegistry],
})
export class CurrenciesModule {}
