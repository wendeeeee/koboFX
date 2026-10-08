import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/users/user.types';

export const ROLES_KEY = 'authentication:roles';

/** Restrict a route to users holding one of these roles (RBAC, design §9.3). */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
