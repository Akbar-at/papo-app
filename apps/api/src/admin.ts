import { Db } from './db';
import { body, fail, json, sha256, signedToken, uuid, type Env } from './platform';
import { sessionAdmin, requireSameOrigin } from './auth';

const text = (v: unknown, label: string, limit = 100): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > limit) return fail(400, 'invalid_request', `${label} is invalid`);
  return v.trim();
};
const id = (v: unknown, label: string): string => uuid(v) ? v : fail(400, 'invalid_request', `${label} must be a UUID`);
const count = (v: unknown, label: string, max: number): number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? v as number : fail(400, 'invalid_request', `${label} is invalid`);
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export async function adminRoutes(request: Request, url: URL, env: Env, db: Db): Promise<Response | null> {
  if (!url.pathname.startsWith('/v1/admin/')) return null;
  const admin = await sessionAdmin(request, env, db);
  if (admin.role !== 'superadmin') return fail(403, 'admin_forbidden', 'Superadmin access required');
  if (url.pathname === '/v1/admin/identity' && request.method === 'GET')
    return json({ id: admin.id, email: admin.email, auth_method: 'app_session', role: admin.role });
  if (url.pathname === '/v1/admin/workspace' && request.method === 'GET') return json(await db.adminWorkspace());
  if (request.method !== 'POST') return null;
  requireSameOrigin(request);
  const input = await body(request);
  const requestId = id(input.request_id, 'request_id');

  if (url.pathname === '/v1/admin/booths') {
    const tenantId = id(input.tenant_id, 'tenant_id'), siteId = id(input.site_id, 'site_id'), name = text(input.name, 'name');
    const credential = await signedToken(env, 'device-credential', requestId);
    const booth = await db.adminEnrollBooth(admin, requestId, tenantId, siteId, name, await sha256(credential));
    if (!booth) return fail(404, 'site_not_found', 'Site does not belong to tenant');
    if (booth.tenant_id !== tenantId || booth.site_id !== siteId || booth.name !== name || booth.device_token_sha256 !== await sha256(credential))
      return fail(409, 'request_conflict', 'Request ID was already used for another booth');
    return json({ booth_id: booth.id, device_credential: credential, session_mode: booth.session_mode }, 201);
  }
  if (url.pathname === '/v1/admin/vouchers') {
    const tenantId = id(input.tenant_id, 'tenant_id');
    const boothId = input.booth_id == null ? null : id(input.booth_id, 'booth_id');
    const expiresAt = text(input.expires_at, 'expires_at', 40);
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 365 * 86_400_000)
      return fail(400, 'invalid_request', 'expires_at must be within the next year');
    const code = (await signedToken(env, 'voucher-code', requestId)).slice(0, 32).toUpperCase();
    const voucher = await db.adminIssueVoucher(admin, requestId, tenantId, boothId, await signedToken(env, 'voucher', code), new Date(expiry).toISOString());
    if (!voucher) return fail(404, 'voucher_scope_invalid', 'Booth does not belong to tenant or expiry is invalid');
    if (voucher.tenant_id !== tenantId || voucher.booth_id !== boothId || voucher.code_digest !== await signedToken(env, 'voucher', code) || new Date(voucher.expires_at).getTime() !== expiry)
      return fail(409, 'request_conflict', 'Request ID was already used for another voucher');
    return json({ voucher_id: voucher.id, code, expires_at: voucher.expires_at, booth_id: voucher.booth_id }, 201);
  }
  if (url.pathname === '/v1/admin/frames') {
    const tenantId = id(input.tenant_id, 'tenant_id'), name = text(input.name, 'name');
    if (!input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest))
      return fail(400, 'invalid_request', 'manifest must be an object');
    const manifest = input.manifest as Record<string, unknown>;
    const hash = await sha256(canonicalJson(manifest));
    const frame = await db.adminPublishFrame(admin, requestId, tenantId, name, manifest, hash);
    if (!frame) return fail(404, 'tenant_not_found', 'Tenant was not found');
    if (frame.tenant_id !== tenantId || frame.name !== name || frame.manifest_sha256 !== hash)
      return fail(409, 'request_conflict', 'Request ID was already used for another frame');
    return json({ frame_version_id: frame.id, manifest_sha256: hash }, 201);
  }
  const configMatch = /^\/v1\/admin\/booths\/([0-9a-f-]+)\/configurations$/.exec(url.pathname);
  if (configMatch) {
    const boothId = id(configMatch[1], 'booth_id');
    if (!Array.isArray(input.frame_version_ids) || input.frame_version_ids.length < 1 || input.frame_version_ids.length > 20 || !input.frame_version_ids.every(uuid) || new Set(input.frame_version_ids).size !== input.frame_version_ids.length)
      return fail(400, 'invalid_request', 'frame_version_ids must contain unique UUIDs');
    const frames = input.frame_version_ids as string[];
    const price = count(input.price_idr, 'price_idr', 100_000_000);
    const first = count(input.first_photo_timer_seconds, 'first_photo_timer_seconds', 60);
    const remaining = count(input.remaining_photo_timer_seconds, 'remaining_photo_timer_seconds', 60);
    const retakes = count(input.retake_limit, 'retake_limit', 8);
    if (!input.camera_settings || typeof input.camera_settings !== 'object' || Array.isArray(input.camera_settings))
      return fail(400, 'invalid_request', 'camera_settings must be an object');
    const camera = input.camera_settings as Record<string, unknown>;
    const config = await db.adminPublishConfig(admin, requestId, boothId, frames, price, first, remaining, retakes, camera);
    if (!config) return fail(409, 'configuration_invalid', 'Booth or tenant frames are unavailable');
    if (config.booth_id !== boothId || !same(config.frame_version_ids, frames) || config.price_idr !== price || config.first_photo_timer_seconds !== first || config.remaining_photo_timer_seconds !== remaining || config.retake_limit !== retakes || !same(config.camera_settings, camera))
      return fail(409, 'request_conflict', 'Request ID was already used for another configuration');
    return json({ booth_id: boothId, desired_version: config.version, published_at: config.published_at }, 201);
  }
  return null;
}
