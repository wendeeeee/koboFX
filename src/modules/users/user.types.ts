/** `user_status` (design §7.1). Never returns to PENDING_VERIFICATION once left. */
export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

/** `user_role` (design §9.3). Granted through roles, never per person. */
export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}
