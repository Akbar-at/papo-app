import { hash } from 'bcryptjs';
export function databaseUrl() {
  const { NEON_DIRECT_DATABASE_URL: url, APP_DATABASE_NAME: name } = process.env;
  if (!url || !name || new URL(url).pathname !== `/${name}`)
    throw new Error('NEON_DIRECT_DATABASE_URL and APP_DATABASE_NAME must match the intended application database');
  return url;
}
export function normalizedEmail() {
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('SUPERADMIN_EMAIL is required');
  return email;
}
export async function passwordHash() {
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!password || password.length < 12 || new TextEncoder().encode(password).length > 72)
    throw new Error('SUPERADMIN_PASSWORD must be at least 12 characters and at most 72 UTF-8 bytes');
  return hash(password, 12);
}
