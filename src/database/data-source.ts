// TypeORM CLI entrypoint (`npm run migration:run`). Connects as the schema owner.
import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source.options';

export default new DataSource(buildDataSourceOptions(loadConfig(process.env).db, 'migration'));
