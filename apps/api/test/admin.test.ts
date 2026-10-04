import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Db } from '../src/db';
import { handle } from '../src/index';
import { hashPassword } from '../src/auth';
import { sha256, type Env } from '../src/platform';

const password = 'A-long-test-password-2026';
async function fixture() {
  const pg = new PGlite();
  for (const migration of ['001_session_core.sql','002_superadmin.sql','003_app_auth.sql'])
    await pg.exec(readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  const tenant = crypto.randomUUID(), site = crypto.randomUUID();
  await pg.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant,'Test']);
  await pg.query('INSERT INTO sites(id,tenant_id,name) VALUES($1,$2,$3)',[site,tenant,'Test']);
  const adminId = (await pg.query<{id:string}>("INSERT INTO admin_users(email,role,password_hash) VALUES('admin@example.test','superadmin',$1) RETURNING id",[await hashPassword(password)])).rows[0].id;
  const env = { DATABASE_URL:'postgresql://test:test@localhost/test', TOKEN_SIGNING_KEY:'a-test-signing-key-with-at-least-32-characters',APP_ENV:'test',PHOTOS:{} } as Env;
  const db = new Db(env);
  (db as unknown as {sql:(parts:TemplateStringsArray,...values:unknown[])=>Promise<unknown[]>}).sql = async (parts,...values) => {
    let sql = parts[0]; values.forEach((_,i)=>{sql+=`$${i+1}${parts[i+1]}`;});return (await pg.query(sql,values)).rows;
  };
  const call = async (path:string,data?:unknown,cookie?:string,origin:string|null='https://api.test') => {
    const headers:Record<string,string> = {};
    if(cookie) headers.cookie=cookie;
    if(origin) headers.origin=origin;
    if(data!==undefined) headers['content-type']='application/json';
    const response=await handle(new Request(`https://api.test${path}`,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)}),env,db);
    return {response,status:response.status,data:await response.json() as Record<string,any>};
  };
  const login = async (pw=password) => {
    const result=await call('/v1/auth/login',{email:'ADMIN@example.test',password:pw});
    return {...result,cookie:result.response.headers.get('set-cookie')?.split(';')[0]};
  };
  return {pg,env,db,tenant,site,adminId,call,login};
}

test('app session provisions a booth, publishes configuration and issues a redeemable voucher',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.call('/v1/admin/workspace')).status,401);
    assert.equal((await f.call('/v1/auth/login',{email:'admin@example.test',password,extra:'x'.repeat(65536)})).status,413);
    const signed=await f.login();assert.equal(signed.status,200);assert.ok(signed.cookie);
    assert.match(signed.response.headers.get('set-cookie')!,/HttpOnly; SameSite=Lax; Secure/);
    assert.ok(signed.cookie.startsWith('__Host-papo_session='));
    assert.equal(signed.data.user.role,'superadmin');assert.equal(signed.data.user.password_hash,undefined);
    const token=signed.cookie.split('=')[1];
    assert.equal((await f.pg.query<{token_sha256:string}>('SELECT token_sha256 FROM admin_sessions')).rows[0].token_sha256,await sha256(token));
    const enrollment={request_id:crypto.randomUUID(),tenant_id:f.tenant,site_id:f.site,name:'Garden booth'};
    assert.equal((await f.call('/v1/admin/booths',enrollment,signed.cookie,'https://other.test')).status,403);
    assert.equal((await f.call('/v1/admin/booths',enrollment,signed.cookie,null)).status,403);
    const created=await f.call('/v1/admin/booths',enrollment,signed.cookie);assert.equal(created.status,201);
    assert.equal((await f.call('/v1/admin/booths',enrollment,signed.cookie)).data.device_credential,created.data.device_credential);
    assert.equal((await f.call('/v1/admin/booths',{...enrollment,name:'Changed'},signed.cookie)).status,409);
    assert.equal((await handle(new Request('https://api.test/v1/admin/workspace',{headers:{authorization:`Bearer ${created.data.device_credential}`}}),f.env,f.db)).status,401);
    const frame=await f.call('/v1/admin/frames',{request_id:crypto.randomUUID(),tenant_id:f.tenant,name:'Garden frame',manifest:{slots:3}},signed.cookie);assert.equal(frame.status,201);
    const config={request_id:crypto.randomUUID(),frame_version_ids:[frame.data.frame_version_id],price_idr:25000,first_photo_timer_seconds:3,remaining_photo_timer_seconds:2,retake_limit:1,camera_settings:{iso:400}};
    const configPath=`/v1/admin/booths/${created.data.booth_id}/configurations`;
    assert.equal((await f.call(configPath,config,signed.cookie)).data.desired_version,1);
    assert.equal((await f.call(configPath,config,signed.cookie)).data.desired_version,1);
    assert.equal((await f.call(configPath,{...config,price_idr:5000},signed.cookie)).status,409);
    assert.equal((await f.call(configPath,{...config,request_id:crypto.randomUUID(),frame_version_ids:[crypto.randomUUID()]},signed.cookie)).status,409);
    const voucherInput={request_id:crypto.randomUUID(),tenant_id:f.tenant,booth_id:created.data.booth_id,expires_at:new Date(Date.now()+86400000).toISOString()};
    const voucher=await f.call('/v1/admin/vouchers',voucherInput,signed.cookie);assert.equal(voucher.status,201);
    assert.equal((await f.call('/v1/admin/vouchers',voucherInput,signed.cookie)).data.code,voucher.data.code);
    const device=await handle(new Request('https://api.test/v1/device/sessions',{method:'POST',headers:{authorization:`Bearer ${created.data.device_credential}`,'content-type':'application/json'},body:JSON.stringify({client_session_id:crypto.randomUUID(),authorization:{kind:'voucher',code:voucher.data.code}})}),f.env,f.db);
    assert.equal(device.status,201);
    const workspace=await f.call('/v1/admin/workspace',undefined,signed.cookie);assert.equal(workspace.status,200);
    assert.equal(workspace.data.booths[0].name,'Garden booth');assert.equal(workspace.data.booths[0].device_token_sha256,undefined);
    assert.equal(workspace.data.vouchers[0].code_digest,undefined);assert.ok(workspace.data.vouchers[0].redeemed_session_id);
    assert.equal((await f.pg.query<{count:number}>('SELECT count(*)::int AS count FROM audit_events')).rows[0].count,4);
    const logout=await f.call('/v1/auth/logout',{},signed.cookie);assert.equal(logout.status,200);assert.match(logout.response.headers.get('set-cookie')!,/Max-Age=0/);
    assert.equal((await f.call('/v1/admin/workspace',undefined,signed.cookie)).status,401);
  } finally {await f.pg.close();}
});

test('password changes revoke every session; expired and inactive identities cannot access admins',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.call('/v1/auth/login',{email:'admin@example.test',password},undefined,'https://evil.test')).status,403);
    assert.equal((await f.login('incorrect-password')).status,401);
    assert.equal((await f.call('/v1/auth/login',{email:'missing@example.test',password})).status,401);
    const first=await f.login(),second=await f.login();assert.ok(first.cookie&&second.cookie);
    assert.equal((await f.call('/v1/auth/password',{current_password:password,new_password:'short'},first.cookie)).status,400);
    assert.equal((await f.call('/v1/auth/password',{current_password:'wrong-password',new_password:'New-password-long-2026'},first.cookie)).status,400);
    assert.equal((await f.call('/v1/auth/password',{current_password:password,new_password:'New-password-long-2026'},first.cookie)).status,200);
    assert.equal((await f.call('/v1/auth/me',undefined,first.cookie)).status,401);
    assert.equal((await f.call('/v1/admin/workspace',undefined,second.cookie)).status,401);
    assert.equal((await f.login()).status,401);
    const renewed=await f.login('New-password-long-2026');assert.equal(renewed.status,200);
    await f.pg.query("UPDATE admin_sessions SET expires_at=now()-interval '1 minute'");
    assert.equal((await f.call('/v1/auth/me',undefined,renewed.cookie)).status,401);
    const active=await f.login('New-password-long-2026');assert.equal(active.status,200);
    await f.pg.query('UPDATE admin_users SET active=false WHERE id=$1',[f.adminId]);
    assert.equal((await f.call('/v1/admin/workspace',undefined,active.cookie)).status,401);
    assert.equal((await f.login('New-password-long-2026')).status,401);
    const key=await sha256('email:limited@example.test');
    const consumed=await Promise.all(Array.from({length:10},()=>f.db.consumeAuthAttempt(key)));
    assert.equal(consumed.filter(Boolean).length,10);
    const limited=await f.call('/v1/auth/login',{email:'limited@example.test',password});
    assert.equal(limited.status,429);assert.equal(limited.response.headers.get('retry-after'),'900');
  } finally {await f.pg.close();}
});
