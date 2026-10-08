import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/user.types';

/** Every controller class in `src/modules`, loaded by walking the tree — a new controller is covered without editing this test. */
function allControllers(): Function[] {
  const root = join(__dirname, '..');
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.controller.ts')) files.push(path);
    }
  };
  walk(root);
  return files.flatMap((file) =>
    Object.values(require(file) as Record<string, unknown>).filter(
      (exported): exported is Function => typeof exported === 'function' && Reflect.getMetadata(PATH_METADATA, exported) !== undefined,
    ),
  );
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly roles: readonly UserRole[] | undefined;
  readonly isPublic: boolean;
}

function routesOf(controller: Function): Route[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function' && Reflect.getMetadata(PATH_METADATA, prototype[name] as object) !== undefined)
    .map((name) => {
      const handler = prototype[name] as object;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
      const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller)) as UserRole[] | undefined;
      const isPublic = Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, controller));
      return { method, path: `/${[base, sub].filter((part) => part && part !== '/').join('/')}`.replace(/\/+/g, '/'), roles, isPublic };
    });
}

describe('RBAC: the role × route matrix over every controller (deny by default)', () => {
  const routes = allControllers().flatMap(routesOf);
  const admin = routes.filter((route) => route.path.startsWith('/admin'));

  it('finds the admin routes (the walk works)', () => {
    expect(admin.length).toBeGreaterThanOrEqual(14);
    expect(relative(__dirname, __filename)).toBe('rbac-matrix.spec.ts');
  });

  it('every /admin route names its roles, none is public, and a plain USER is never among them', () => {
    for (const route of admin) {
      expect({ route: `${route.method} ${route.path}`, hasRoles: (route.roles ?? []).length > 0, isPublic: route.isPublic }).toEqual({
        route: `${route.method} ${route.path}`,
        hasRoles: true,
        isPublic: false,
      });
      expect(route.roles).not.toContain(UserRole.USER);
    }
  });

  it('the matrix: who may call what', () => {
    const allowed = (method: string, path: string) => admin.find((route) => route.method === method && route.path === path)?.roles;
    expect(allowed('POST', '/admin/approvals')).toEqual([UserRole.ADMIN]);
    expect(allowed('POST', '/admin/approvals/:approvalId/cancel')).toEqual([UserRole.ADMIN]);
    expect(allowed('POST', '/admin/approvals/:approvalId/review')).toEqual([UserRole.SECURITY]);
    expect(allowed('GET', '/admin/recertification')).toEqual([UserRole.SECURITY]);
    // Approve / reject: both roles reach the route; which one may decide depends on the action (service + database).
    expect(allowed('POST', '/admin/approvals/:approvalId/approve')).toEqual([UserRole.ADMIN, UserRole.SECURITY]);
    expect(allowed('GET', '/admin/positions')).toEqual([UserRole.ADMIN, UserRole.SECURITY]);
  });

  it('no route outside /admin demands a privileged role (users keep their own surface)', () => {
    for (const route of routes.filter((candidate) => !candidate.path.startsWith('/admin'))) {
      expect({ route: `${route.method} ${route.path}`, roles: route.roles ?? [] }).toEqual({ route: `${route.method} ${route.path}`, roles: [] });
    }
  });
});
