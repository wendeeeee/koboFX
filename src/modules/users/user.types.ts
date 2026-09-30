/** `user_status` (design §7.1). Never returns to PENDING_VERIFICATION once left. */
export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

/**
 * `user_role` (design §9.3). Granted through roles, never per person; ONE role per person (Phase 10), so a
 * security officer is never also an administrator. ADMIN runs the money controls (request, approve another's);
 * SECURITY approves role changes and reviews break-glass use.
 */
export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
  SECURITY = 'SECURITY',
}
