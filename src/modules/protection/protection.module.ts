import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DataKeyStore } from './data-key.store';
import { ProtectedEvidenceService } from './protected-evidence.service';
import { ProtectionService } from './protection.service';

/** Protected envelopes (WITHDRAWAL_PLAN.md §H): data keys, sealing, keyed fingerprints, protected provider evidence. */
@Module({
  imports: [AuditModule],
  providers: [DataKeyStore, ProtectionService, ProtectedEvidenceService],
  exports: [DataKeyStore, ProtectionService, ProtectedEvidenceService],
})
export class ProtectionModule {}
