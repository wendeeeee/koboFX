import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';


export const MINOR_UNITS_PATTERN_18 = '^[1-9]\\d{0,17}$';
export const MINOR_UNITS_PATTERN_19 = '^[1-9]\\d{0,18}$';

export const SIGNED_MINOR_UNITS_PATTERN = '^-?\\d+$';
export const CURRENCY_PATTERN = '^[A-Z]{3}$';

const MINOR_UNITS_NOTE =
  'A whole number of minor units, as a string (never a JSON number). The scale is the currency\'s `minorUnit`: NGN 2 ' +
  '(`"150000"` = ₦1,500.00), USD 2, JPY 0 (`"1500"` = ¥1,500), KWD 3 (`"1500"` = 1.500 KWD).';

type Extra = Omit<ApiPropertyOptions, 'type' | 'format' | 'pattern' | 'example'> & { nullable?: boolean };

export const ApiMinorUnits = (description: string, example: string, pattern: string, options: Extra = {}): PropertyDecorator =>
  ApiProperty({ ...options, type: 'string', pattern, example, description: `${description} ${MINOR_UNITS_NOTE}` } as ApiPropertyOptions);

export const ApiAmount = (description: string, example: string | null, options: Extra = {}): PropertyDecorator =>
  ApiProperty({
    ...options,
    type: 'string',
    pattern: SIGNED_MINOR_UNITS_PATTERN,
    example,
    description: `${description} ${MINOR_UNITS_NOTE}`,
  } as ApiPropertyOptions);

export const ApiCurrency = (description = 'ISO 4217 code.', example = 'NGN', options: Extra = {}): PropertyDecorator =>
  ApiProperty({ ...options, type: 'string', pattern: CURRENCY_PATTERN, example, description } as ApiPropertyOptions);

export const ApiMinorUnit = (): PropertyDecorator =>
  ApiProperty({ type: 'integer', minimum: 0, example: 2, description: 'Decimal places of the currency (from the database): NGN 2, USD 2, JPY 0, KWD 3.' });

export const ApiUuid = (description: string, example: string, options: Extra = {}): PropertyDecorator =>
  ApiProperty({ ...options, type: 'string', format: 'uuid', example, description } as ApiPropertyOptions);

export const ApiInstant = (description: string, example: string | null = '2026-09-29T10:00:00.000Z', options: Extra = {}): PropertyDecorator =>
  ApiProperty({ ...options, type: 'string', format: 'date-time', example, description } as ApiPropertyOptions);

export const ApiDisplayRate = (description: string, example: string): PropertyDecorator =>
  ApiProperty({ type: 'string', pattern: '^\\d+(\\.\\d+)?$', example, description: `${description} Display only (12 significant digits); the amounts are authoritative.` });

export const ApiFreeObject = (description: string, options: Extra & { example?: unknown } = {}): PropertyDecorator =>
  ApiProperty({ ...options, type: 'object', additionalProperties: true, description } as ApiPropertyOptions);
