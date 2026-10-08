/** `user_status` (design §7.1). Never returns to PENDING_VERIFICATION once left. */
export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}


export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
  SECURITY = 'SECURITY',
}
