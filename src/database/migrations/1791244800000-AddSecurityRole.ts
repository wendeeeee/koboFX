import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `user_role` gains `SECURITY` (Phase 10 decision: three roles, one per person). A security
 * officer approves role changes and reviews break-glass use; an ADMIN runs the money controls.
 * `users.role` stays ONE column, so nobody can hold both — segregation of duties by construction.
 *
 * On its own: a new enum value cannot be used in the transaction that adds it.
 */
export class AddSecurityRole1791244800000 implements MigrationInterface {
  name = 'AddSecurityRole1791244800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE user_role ADD VALUE 'SECURITY'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; `CreateRoleAssignments`' down returns every holder to USER.
  }
}
