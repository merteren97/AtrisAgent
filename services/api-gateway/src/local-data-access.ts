import type { Request } from 'express';
import { authorizeRuntimeToken } from './runtime-protocol';

/** Local configuration/history ownership is independent of Hub entitlement.
 * Keep this method/path allowlist explicit: executing agents still uses Hub auth.
 */
export function isLocalDataRequest(req: Request, runtimeToken?: string): boolean {
  if (!runtimeToken || !authorizeRuntimeToken(runtimeToken, req.headers, req.originalUrl || req.url).ok) return false;
  const pathname = (req.originalUrl || req.url).split('?')[0].replace(/\/$/, '');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const routes: Array<[string, RegExp]> = [
    ['GET|POST', /^\/api\/team-templates$/],
    ['PATCH|DELETE', /^\/api\/team-templates\/[^/]+$/],
    ['POST', /^\/api\/team-templates\/[^/]+\/default$/],
    ['GET|DELETE', /^\/api\/execution-policies\/(team_template|workspace|mission)\/[^/]+$/],
    ['PUT', /^\/api\/execution-policies\/(team_template|workspace|mission)\/[^/]+\/[^/]+$/],
    ['GET|POST', /^\/api\/agent-profiles$/],
    ['GET|PUT|POST|DELETE', /^\/api\/agent-profiles\/bindings$/],
    ['GET|PATCH|DELETE', /^\/api\/agent-profiles\/[^/]+$/],
    ['GET', /^\/api\/(workspaces|team-templates)\/[^/]+\/(agent-profile-bindings|agent-profiles)$/],
    ['PUT|POST|DELETE', /^\/api\/(workspaces|team-templates)\/[^/]+\/(agent-profile-bindings|agent-profiles)\/[^/]+$/],
    ['GET|POST', /^\/api\/accounts$/],
    ['PATCH|DELETE', /^\/api\/accounts\/[^/]+$/],
    ['POST', /^\/api\/accounts\/[^/]+\/(auth\/begin|verify|logout|models\/refresh)$/],
    ['GET', /^\/api\/accounts\/[^/]+\/auth\/[^/]+$/],
    ['GET', /^\/api\/(models|runtimes)$/],
    ['POST', /^\/api\/runtimes\/discover$/],
    ['GET', /^\/api\/(workspaces|missions|mission-commands)$/],
    ['GET|DELETE', /^\/api\/(workspaces|missions)\/[^/]+$/],
    ['GET', /^\/api\/missions\/[^/]+\/deletion$/],
    ['GET', /^\/api\/manual\/conversations$/],
    ['GET|DELETE', /^\/api\/manual\/conversations\/[^/]+$/],
    ['DELETE', /^\/api\/manual\/agents\/[^/]+$/],
  ];
  return routes.some(([methods, pattern]) => methods.split('|').includes(method) && pattern.test(pathname));
}
