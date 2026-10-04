import { compare, hash } from 'bcryptjs';
import { Db, type Admin } from './db';
import { body, fail, json, sha256, type Env } from './platform';

const SESSION_HOURS = 12;
// A real bcrypt hash gives missing users the same verification cost.
const DUMMY_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxE1MQiBJK5LMbCbbFLgMqFcV.G';
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || new TextEncoder().encode(password).length > 72)
    fail(400, 'invalid_password', 'Use a password of at least 12 characters and at most 72 UTF-8 bytes');
}
export async function hashPassword(password: unknown): Promise<string> {
  validatePassword(password);
  return hash(password, 12);
}

function cookieSettings(request: Request, env: Env) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  if (!secure && !(env.APP_ENV === 'local' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    return fail(503, 'https_required', 'Admin authentication requires HTTPS');
  return { name: secure ? '__Host-papo_session' : 'papo_local_session', suffix: `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` };
}
function sessionToken(request: Request, env: Env): string | null {
  const { name } = cookieSettings(request, env);
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(item => item.trim());
  const matches = cookies.filter(item => item.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
export function requireSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    fail(403, 'origin_rejected', 'This request must come from the application');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'json_required', 'Use application/json');
}
export async function sessionAdmin(request: Request, env: Env, db: Db): Promise<Admin> {
  const token = sessionToken(request, env);
  const admin = token ? await db.adminForSession(await sha256(token)) : null;
  return admin ?? fail(401, 'admin_unauthorized', 'Please sign in');
}
const publicAdmin = (admin: Admin) => ({ id: admin.id, email: admin.email, role: admin.role });
const clearCookie = (request: Request, env: Env) => {
  const { name, suffix } = cookieSettings(request, env);
  return `${name}=; ${suffix}; Max-Age=0`;
};

export async function authRoutes(request: Request, url: URL, env: Env, db: Db, clientIp?: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/v1/auth/')) return null;
  if (url.pathname === '/v1/auth/me' && request.method === 'GET')
    return json({ user: publicAdmin(await sessionAdmin(request, env, db)) });
  if (request.method !== 'POST') return null;
  requireSameOrigin(request);
  if (url.pathname === '/v1/auth/login') {
    cookieSettings(request, env);
    const input = await body(request);
    if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
        typeof input.password !== 'string' || new TextEncoder().encode(input.password).length > 72)
      return fail(401, 'invalid_credentials', 'Email or password is incorrect');
    const email = input.email.trim().toLowerCase();
    // Persisted atomic counters work across Worker instances and restarts.
    const keys = [{key:await sha256(`email:${email}`),limit:10}, {key:await sha256(`ip:${clientIp ?? 'unknown'}`),limit:100}];
    for (const {key,limit} of keys) if (!await db.consumeAuthAttempt(key,limit)) {
      const response = json({ error: { code: 'login_limited', message: 'Too many attempts. Try again in 15 minutes.' } }, 429);
      response.headers.set('retry-after', '900'); return response;
    }
    const admin = await db.adminByEmail(email);
    const valid = await compare(input.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin?.active || !admin.password_hash || !valid)
      return fail(401, 'invalid_credentials', 'Email or password is incorrect');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    // Re-check password and active state in the insertion to avoid a password
    // reset or account revocation racing with bcrypt verification.
    if (!await db.createAdminSession(admin.id, admin.password_hash, await sha256(token), SESSION_HOURS))
      return fail(401, 'invalid_credentials', 'Email or password is incorrect');
    const previous = sessionToken(request, env);
    if (previous) await db.revokeAdminSession(await sha256(previous));
    const response = json({ user: publicAdmin(admin) });
    const { name, suffix } = cookieSettings(request, env);
    response.headers.set('set-cookie', `${name}=${token}; ${suffix}; Max-Age=${SESSION_HOURS * 3600}`);
    return response;
  }
  if (url.pathname === '/v1/auth/logout') {
    const token = sessionToken(request, env);
    if (token) await db.revokeAdminSession(await sha256(token));
    const response = json({ ok: true }); response.headers.set('set-cookie', clearCookie(request, env)); return response;
  }
  if (url.pathname === '/v1/auth/password') {
    const admin = await sessionAdmin(request, env, db);
    const input = await body(request);
    if (typeof input.current_password !== 'string' || new TextEncoder().encode(input.current_password).length > 72)
      return fail(400, 'invalid_credentials', 'Current password is incorrect');
    if (!await db.consumeAuthAttempt(await sha256(`password:${admin.id}`)))
      return fail(429, 'login_limited', 'Too many attempts. Try again in 15 minutes.');
    const stored = await db.adminByEmail(admin.email);
    if (!stored?.password_hash || !await compare(input.current_password, stored.password_hash))
      return fail(400, 'invalid_credentials', 'Current password is incorrect');
    const nextHash = await hashPassword(input.new_password);
    if (!await db.changeAdminPassword(admin.id, stored.password_hash, nextHash))
      return fail(409, 'password_conflict', 'Account changed; sign in again');
    const response = json({ ok: true }); response.headers.set('set-cookie', clearCookie(request, env)); return response;
  }
  return null;
}
