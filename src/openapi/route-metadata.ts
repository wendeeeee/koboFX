import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ALLOW_UNVERIFIED_KEY } from '../common/decorators/allow-unverified.decorator';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../common/decorators/idempotent.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { RATE_LIMIT_KEY, RateLimitPolicy, SKIP_RATE_LIMIT_KEY } from '../common/decorators/rate-limit.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ErrorCode } from '../common/errors';
import { UserRole } from '../modules/users/user.types';
import { API_ERRORS_KEY } from './api-errors.decorator';

/**
 * One HTTP route as the guard chain sees it: the SAME metadata keys, resolved the same way
 * (`getAllAndOverride(handler, class)`), so the document cannot claim a guard the route does not run.
 */
export interface RouteDescriptor {
  readonly controller: Type<unknown>;
  readonly methodKey: string;
  /** `@nestjs/swagger`'s default operation id: `${Controller}_${method}`. */
  readonly operationId: string;
  readonly requestMethod: RequestMethod;
  readonly isPublic: boolean;
  readonly allowUnverified: boolean;
  readonly roles: readonly UserRole[];
  readonly idempotent: IdempotentOptions | undefined;
  readonly rateLimit: RateLimitPolicy | undefined;
  readonly skipRateLimit: boolean;
  readonly errors: readonly ErrorCode[];
  /** The handler takes `@Body()`, `@Query()` or `@Param()`: the global `ValidationPipe` (or a param pipe) runs. */
  readonly validatesInput: boolean;
  readonly hasBody: boolean;
}

const reflector = new Reflector();

function argumentTypes(controller: Type<unknown>, methodKey: string): RouteParamtypes[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodKey) ?? {}) as Record<string, unknown>;
  // Built-in parameters are keyed `${RouteParamtypes}:${index}`; custom ones (`@CurrentUser()`) `${uuid}__customRouteArgs__:${index}`.
  return Object.keys(args)
    .map((key) => /^(\d+):\d+$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1] as string, 10) as RouteParamtypes);
}

/** Every route handler of every controller registered in the application. */
export function collectRoutes(app: INestApplication): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];
  const seen = new Set<Type<unknown>>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller || seen.has(controller)) continue;
      seen.add(controller);
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodKey of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[methodKey];
        if (methodKey === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const targets = [handler, controller];
        const types = argumentTypes(controller, methodKey);
        routes.push({
          controller,
          methodKey,
          operationId: `${controller.name}_${methodKey}`,
          requestMethod: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
          isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true,
          allowUnverified: reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, targets) === true,
          roles: reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets) ?? [],
          idempotent: reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_KEY, handler as () => unknown),
          rateLimit: reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_KEY, targets),
          skipRateLimit: reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets) === true,
          errors: reflector.get<ErrorCode[] | undefined>(API_ERRORS_KEY, handler as () => unknown) ?? [],
          validatesInput: types.some((type) => type === RouteParamtypes.BODY || type === RouteParamtypes.QUERY || type === RouteParamtypes.PARAM),
          hasBody: types.includes(RouteParamtypes.BODY),
        });
      }
    }
  }
  return routes;
}
