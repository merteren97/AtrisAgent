import { createHash } from 'node:crypto';
import type { Application, NextFunction, Request, Response as ExpressResponse } from 'express';

const DEFAULT_HUB_BASE_URL = 'https://atrishub.com';
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_STALE_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;

export interface AtrisMembership {
  status?: string;
  plan?: string;
  [key: string]: unknown;
}

export interface AtrisSession {
  user: {
    id: string;
    email?: string;
    [key: string]: unknown;
  };
  membership?: AtrisMembership;
  entitlement?: AtrisMembership & { product?: string };
  [key: string]: unknown;
}

export interface AuthenticatedRequest extends Request {
  atrisAuth?: {
    session: AtrisSession;
    tokenHash: string;
    stale: boolean;
  };
}

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;

export interface AtrisAuthServiceOptions {
  baseUrl?: string;
  fetchImpl?: FetchImplementation;
  cacheTtlMs?: number;
  staleCacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface CachedSession {
  session: AtrisSession;
  validatedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface HubResponse {
  response: globalThis.Response;
  payload: unknown;
}

export interface ProxyResponse {
  status: number;
  body: unknown;
}

export class HubAuthRejectedError extends Error {
  readonly kind = 'rejected';

  constructor() {
    super('AtrisHub rejected the session token.');
    this.name = 'HubAuthRejectedError';
  }
}

export class HubAuthUnavailableError extends Error {
  readonly kind = 'unavailable';

  constructor() {
    super('AtrisHub could not be reached or returned an unusable session response.');
    this.name = 'HubAuthUnavailableError';
  }
}

class HubAuthTransportError extends HubAuthUnavailableError {
  readonly transport = true;
}

const CONTROL_PLANE_CALL_PATH = '/api/internal/control-plane/call';

function requestPath(req: Request): string {
  const originalUrl = req.originalUrl || req.url || '';
  const queryStart = originalUrl.indexOf('?');
  return queryStart >= 0 ? originalUrl.slice(0, queryStart) : originalUrl;
}

function isControlPlaneCall(req: Request): boolean {
  return req.method === 'POST' && requestPath(req) === CONTROL_PLANE_CALL_PATH;
}

function boundedMilliseconds(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

function defaultFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function extractBearerHeader(authorization: unknown): string | null {
  if (Array.isArray(authorization)) authorization = authorization[0];
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] || null;
}

export function extractBearerToken(req: Pick<Request, 'headers'>): string | null {
  return extractBearerHeader(req.headers.authorization);
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePayload(value: unknown, allowLoginToken = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, allowLoginToken));
  if (!isRecord(value)) return value;

  const secretKeys = new Set(['password', 'passwordHash', 'refreshToken', 'accessToken', 'apiKey', 'secret']);
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKeys.has(key) || (!allowLoginToken && key === 'token')) continue;
    output[key] = sanitizePayload(item, allowLoginToken);
  }
  return output;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * AtrisHub intentionally stores managed upload paths as relative URLs (for
 * example `/uploads/profiles/avatar.jpg`). A browser on atrishub.com resolves
 * those paths correctly, while a packaged Tauri WebView would otherwise point
 * them at its own local application origin. Normalize the desktop-facing auth
 * contract at the gateway boundary so every client receives a fetchable URL.
 */
export function normalizeAvatarUrl(value: unknown, hubBaseUrl: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const base = new URL(hubBaseUrl);
    base.pathname = '/';
    base.search = '';
    base.hash = '';
    const resolved = new URL(trimmed, base);
    const secure = resolved.protocol === 'https:';
    const localDevelopment = resolved.protocol === 'http:' && isLoopbackHostname(resolved.hostname);
    if ((!secure && !localDevelopment) || resolved.username || resolved.password) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function normalizePayloadAvatar(payload: unknown, hubBaseUrl: string): unknown {
  if (!isRecord(payload) || !isRecord(payload.user) || !Object.prototype.hasOwnProperty.call(payload.user, 'avatarUrl')) {
    return payload;
  }

  return {
    ...payload,
    user: {
      ...payload.user,
      avatarUrl: normalizeAvatarUrl(payload.user.avatarUrl, hubBaseUrl),
    },
  };
}

function parseSession(payload: unknown): AtrisSession {
  if (!isRecord(payload) || !isRecord(payload.user) || typeof payload.user.id !== 'string' || !payload.user.id.trim()) {
    throw new HubAuthUnavailableError();
  }
  return sanitizePayload(payload) as AtrisSession;
}

export function hasPremiumEntitlement(session: AtrisSession): boolean {
  const membership = session.membership || session.entitlement;
  const status = String(membership?.status || '').trim().toLowerCase();
  const plan = String(membership?.plan || '').trim().toLowerCase();
  return status === 'active' && (plan === 'premium' || plan === 'admin');
}

function sendError(res: ExpressResponse, status: number, error: string, code: string): void {
  res.status(status).json({ error, code });
}

function sendProxyBody(res: ExpressResponse, proxy: ProxyResponse): void {
  if (isRecord(proxy.body) || Array.isArray(proxy.body)) {
    res.status(proxy.status).json(proxy.body);
    return;
  }
  res.status(proxy.status).type('text/plain').send(proxy.body == null ? '' : String(proxy.body));
}

export class AtrisAuthService {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly cacheTtlMs: number;
  private readonly staleCacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedSession>();

  constructor(options: AtrisAuthServiceOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.ATRIS_AUTH_API_URL || DEFAULT_HUB_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || defaultFetch;
    this.cacheTtlMs = boundedMilliseconds(
      options.cacheTtlMs ?? process.env.ATRIS_AUTH_CACHE_MS ?? process.env.ATRIS_ENTITLEMENT_CACHE_MS,
      DEFAULT_CACHE_TTL_MS,
      1,
      300_000,
    );
    this.staleCacheTtlMs = boundedMilliseconds(
      options.staleCacheTtlMs ?? process.env.ATRIS_AUTH_STALE_CACHE_MS,
      DEFAULT_STALE_CACHE_TTL_MS,
      0,
      300_000,
    );
    this.timeoutMs = boundedMilliseconds(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000);
    this.now = options.now || Date.now;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private url(pathname: string): string {
    return `${this.baseUrl}/${pathname.replace(/^\/+/, '')}`;
  }

  private async requestHub(pathname: string, init: RequestInit): Promise<HubResponse> {
    try {
      const headers = new Headers(init.headers || {});
      headers.set('Accept', 'application/json');
      const signal = init.signal || (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined);
      const response = await this.fetchImpl(this.url(pathname), { ...init, headers, signal });
      const text = await response.text();
      let payload: unknown = text;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      return { response, payload };
    } catch {
      throw new HubAuthTransportError();
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.staleUntil <= now) this.cache.delete(key);
    }
  }

  private async fetchSession(token: string, tokenHash: string, allowStaleOnFailure: boolean): Promise<{ session: AtrisSession; stale: boolean }> {
    const cached = this.cache.get(tokenHash);
    try {
      const { response, payload } = await this.requestHub('/api/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        this.cache.delete(tokenHash);
        throw new HubAuthRejectedError();
      }
      if (!response.ok) throw new HubAuthUnavailableError();

      const session = normalizePayloadAvatar(parseSession(payload), this.baseUrl) as AtrisSession;
      const now = this.now();
      this.cache.set(tokenHash, {
        session,
        validatedAt: now,
        freshUntil: now + this.cacheTtlMs,
        staleUntil: now + this.cacheTtlMs + this.staleCacheTtlMs,
      });
      return { session, stale: false };
    } catch (error) {
      if (error instanceof HubAuthRejectedError) throw error;
      const now = this.now();
      if (error instanceof HubAuthTransportError && allowStaleOnFailure && cached && cached.staleUntil > now) {
        return { session: cached.session, stale: true };
      }
      throw new HubAuthUnavailableError();
    }
  }

  async authenticate(token: string, method: string): Promise<{ session: AtrisSession; tokenHash: string; stale: boolean }> {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new HubAuthRejectedError();
    const tokenHash = hashToken(normalizedToken);
    const now = this.now();
    this.prune(now);
    const cached = this.cache.get(tokenHash);
    const readOnlyRequest = method === 'GET' || method === 'HEAD';
    if (readOnlyRequest && cached && cached.freshUntil > now) {
      return { session: cached.session, tokenHash, stale: false };
    }

    const result = await this.fetchSession(normalizedToken, tokenHash, readOnlyRequest);
    return { ...result, tokenHash };
  }

  async login(body: unknown): Promise<ProxyResponse> {
    const result = await this.requestHub('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const sanitized = sanitizePayload(result.payload, result.response.ok);
    return {
      status: result.response.status,
      body: normalizePayloadAvatar(sanitized, this.baseUrl),
    };
  }

  async logout(token: string | null): Promise<ProxyResponse> {
    if (!token) return { status: 200, body: { success: true, forwarded: false, localOnly: true } };

    const tokenHash = hashToken(token);
    this.cache.delete(tokenHash);
    try {
      const result = await this.requestHub('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (result.response.ok) {
        const body = isRecord(result.payload) ? sanitizePayload(result.payload) as JsonObject : {};
        return { status: result.response.status, body: { ...body, success: body.success ?? true, forwarded: true } };
      }
      return { status: 200, body: { success: true, forwarded: true, localOnly: true, upstreamStatus: result.response.status } };
    } catch {
      return { status: 200, body: { success: true, forwarded: false, localOnly: true } };
    }
  }

  async authorizeWebSocket(token: string): Promise<{ allowed: boolean; status: number }> {
    try {
      const authenticated = await this.authenticate(token, 'GET');
      if (authenticated.stale) return { allowed: false, status: 503 };
      const allowed = hasPremiumEntitlement(authenticated.session);
      return { allowed, status: allowed ? 200 : 403 };
    } catch (error) {
      if (error instanceof HubAuthRejectedError) return { allowed: false, status: 401 };
      return { allowed: false, status: 503 };
    }
  }

  requireAuth = async (req: Request, res: ExpressResponse, next: NextFunction): Promise<void> => {
    if (isControlPlaneCall(req)) return next();
    if (req.method === 'OPTIONS') return next();
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, 401, 'Unauthorized: Atris session token is missing.', 'AUTH_TOKEN_MISSING');
      return;
    }

    try {
      const authenticated = await this.authenticate(token, req.method);
      (req as AuthenticatedRequest).atrisAuth = authenticated;
      next();
    } catch (error) {
      if (error instanceof HubAuthRejectedError) {
        sendError(res, 401, 'Unauthorized: Atris session could not be verified.', 'AUTH_INVALID');
        return;
      }
      sendError(res, 503, 'AtrisAgent could not verify the AtrisHub session. Reconnect to AtrisHub and try again.', 'AUTH_UPSTREAM_UNAVAILABLE');
    }
  };

  requirePremium = (req: Request, res: ExpressResponse, next: NextFunction): void => {
    if (isControlPlaneCall(req)) return next();
    const authenticated = (req as AuthenticatedRequest).atrisAuth;
    if (!authenticated) {
      sendError(res, 401, 'Unauthorized: Missing Atris session context.', 'AUTH_CONTEXT_MISSING');
      return;
    }
    if (authenticated.stale) {
      sendError(res, 503, 'AtrisAgent could not verify the AtrisHub session. Reconnect to AtrisHub and try again.', 'AUTH_UPSTREAM_UNAVAILABLE');
      return;
    }
    if (!hasPremiumEntitlement(authenticated.session)) {
      sendError(res, 403, 'Forbidden: Active AtrisAgent premium entitlement required.', 'PREMIUM_REQUIRED');
      return;
    }
    next();
  };
}

export function installAuthRoutes(app: Application, service: AtrisAuthService): void {
  app.post('/api/auth/login', async (req, res) => {
    try {
      sendProxyBody(res, await service.login(req.body));
    } catch {
      sendError(res, 503, 'AtrisHub authentication service is unavailable.', 'AUTH_UPSTREAM_UNAVAILABLE');
    }
  });

  app.get('/api/auth/me', service.requireAuth, (req, res) => {
    const authenticated = (req as AuthenticatedRequest).atrisAuth;
    if (!authenticated) {
      sendError(res, 401, 'Unauthorized: Missing Atris session context.', 'AUTH_CONTEXT_MISSING');
      return;
    }
    res.status(200).json(authenticated.session);
  });

  app.post('/api/auth/logout', async (req, res) => {
    sendProxyBody(res, await service.logout(extractBearerToken(req)));
  });

  app.use('/api', service.requireAuth, service.requirePremium);
}
