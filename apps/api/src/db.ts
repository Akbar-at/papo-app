import { neon } from '@neondatabase/serverless';
import { fail, sha256, type Env } from './platform';

export type Booth = {id:string;tenant_id:string;name:string;active:boolean;session_mode:'disabled'|'event'|'voucher'|'paid';price_idr:number;config_version:number;applied_config_version:number};
export type Session = {id:string;tenant_id:string;booth_id:string;client_session_id:string;frame_version_id:string|null;config_version:number;mode:'event'|'voucher'|'paid';price_idr:number;status:'authorized'|'captured'|'ready'|'cancelled';capture_event_id:string|null;photo_count:number|null};
export type Upload = {id:string;session_id:string;kind:'composite'|'gif';content_type:string;byte_size:number;sha256:string;object_key:string;expires_at:string;uploaded_at:string|null;retention_at:string;deleted_at:string|null};
export type BoothConfig = {booth_id:string;version:number;frame_version_ids:string[];price_idr:number;first_photo_timer_seconds:number;remaining_photo_timer_seconds:number;retake_limit:number;camera_settings:Record<string,unknown>;published_at:string};
export type Admin = {id:string;email:string;role:'superadmin'};
export type AdminAccount = Admin & {password_hash:string|null;active:boolean};
export type Query = (parts:TemplateStringsArray,...values:unknown[])=>Promise<Record<string,any>[]>;
export class Db {
  private sql:Query;
  constructor(env:Env,query?:Query){if(!query&&!env.DATABASE_URL)fail(503,'database_unconfigured','Database is not configured');this.sql=query??neon(env.DATABASE_URL);}
  async adminByEmail(email:string):Promise<AdminAccount|null>{
    const rows=await this.sql`SELECT id,email,role,active,password_hash FROM admin_users WHERE lower(email)=${email}`;
    return rows[0] as AdminAccount|undefined??null;
  }
  async adminForSession(digest:string):Promise<Admin|null>{
    const rows=await this.sql`SELECT a.id,a.email,a.role FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_sha256=${digest} AND s.expires_at>now() AND a.active=true`;
    return rows[0] as Admin|undefined??null;
  }
  async createAdminSession(adminId:string,passwordHash:string,digest:string,hours:number):Promise<boolean>{
    await this.sql`DELETE FROM admin_sessions WHERE expires_at<=now()`;
    const rows=await this.sql`INSERT INTO admin_sessions(token_sha256,admin_id,expires_at) SELECT ${digest},id,now()+make_interval(hours=>${hours}) FROM admin_users WHERE id=${adminId} AND active=true AND password_hash=${passwordHash} RETURNING admin_id`;
    return rows.length===1;
  }
  async revokeAdminSession(digest:string):Promise<void>{await this.sql`DELETE FROM admin_sessions WHERE token_sha256=${digest}`;}
  async changeAdminPassword(id:string,oldHash:string,newHash:string):Promise<boolean>{
    const rows=await this.sql`SELECT change_admin_password(${id},${oldHash},${newHash}) AS changed`;
    return rows[0].changed as boolean;
  }
  async consumeAuthAttempt(key:string,limit=10):Promise<boolean>{
    await this.sql`DELETE FROM auth_attempts WHERE window_end<=now()`;
    const rows=await this.sql`INSERT INTO auth_attempts(key,attempts,window_end) VALUES(${key},1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts`;
    return (rows[0].attempts as number)<=limit;
  }
  async adminWorkspace(){
    const tenants=await this.sql`SELECT id,name FROM tenants ORDER BY name,id`;
    const sites=await this.sql`SELECT id,tenant_id,name FROM sites ORDER BY name,id`;
    const booths=await this.sql`SELECT id,tenant_id,site_id,name,active,session_mode,price_idr,config_version,applied_config_version FROM booths ORDER BY created_at DESC,id`;
    const frames=await this.sql`SELECT id,tenant_id,name,manifest FROM frame_versions ORDER BY created_at DESC,id`;
    const configurations=await this.sql`SELECT c.* FROM booth_config_versions c JOIN booths b ON b.id=c.booth_id AND b.config_version=c.version`;
    const vouchers=await this.sql`SELECT id,tenant_id,booth_id,expires_at,redeemed_session_id FROM vouchers ORDER BY created_at DESC,id LIMIT 100`;
    return {tenants,sites,booths,frames,configurations,vouchers};
  }
  async adminEnrollBooth(actor:Admin,requestId:string,tenantId:string,siteId:string,name:string,digest:string):Promise<(Booth&{site_id:string;name:string;device_token_sha256:string})|null>{
    const rows=await this.sql`SELECT * FROM admin_enroll_booth(${actor.id},${requestId},${tenantId},${siteId},${name},${digest})`;
    return rows[0] as Booth&{site_id:string;name:string;device_token_sha256:string}|undefined??null;
  }
  async adminIssueVoucher(actor:Admin,requestId:string,tenantId:string,boothId:string|null,digest:string,expiresAt:string):Promise<{id:string;tenant_id:string;booth_id:string|null;code_digest:string;expires_at:string}|null>{
    const rows=await this.sql`SELECT * FROM admin_issue_voucher(${actor.id},${requestId},${tenantId},${boothId},${digest},${expiresAt})`;
    return rows[0] as {id:string;tenant_id:string;booth_id:string|null;code_digest:string;expires_at:string}|undefined??null;
  }
  async adminPublishFrame(actor:Admin,requestId:string,tenantId:string,name:string,manifest:Record<string,unknown>,hash:string):Promise<{id:string;tenant_id:string;name:string;manifest_sha256:string}|null>{
    const rows=await this.sql`SELECT * FROM admin_publish_frame(${actor.id},${requestId},${tenantId},${name},${JSON.stringify(manifest)}::jsonb,${hash})`;
    return rows[0] as {id:string;tenant_id:string;name:string;manifest_sha256:string}|undefined??null;
  }
  async adminPublishConfig(actor:Admin,requestId:string,boothId:string,frames:string[],price:number,first:number,remaining:number,retakes:number,camera:Record<string,unknown>):Promise<BoothConfig|null>{
    const rows=await this.sql`SELECT * FROM admin_publish_configuration(${actor.id},${requestId},${boothId},${frames}::uuid[],${price},${first},${remaining},${retakes},${JSON.stringify(camera)}::jsonb)`;
    return rows[0] as BoothConfig|undefined??null;
  }
  async boothForToken(raw:string):Promise<Booth>{
    const rows=await this.sql`SELECT id,tenant_id,name,active,session_mode,price_idr,config_version,applied_config_version FROM booths WHERE device_token_sha256=${await sha256(raw)}`;
    const booth=rows[0] as Booth|undefined;
    if(!booth||!booth.active)return fail(401,'unauthorized','Device credential is invalid or revoked');return booth;
  }
  async recentSessions(booth:Booth):Promise<{id:string;status:string;mode:string;created_at:string;photo_count:number|null;frame_name:string|null;share_expires_at:string|null;composite_uploaded:boolean;gif_uploaded:boolean;print_confirmed:boolean}[]>{
    return await this.sql`SELECT s.id,s.status,s.mode,s.created_at,s.photo_count,f.name AS frame_name,
      sh.expires_at AS share_expires_at,
      EXISTS(SELECT 1 FROM media_uploads m WHERE m.session_id=s.id AND m.kind='composite' AND m.uploaded_at IS NOT NULL AND m.deleted_at IS NULL AND (m.retention_at IS NULL OR m.retention_at>now())) AS composite_uploaded,
      EXISTS(SELECT 1 FROM media_uploads m WHERE m.session_id=s.id AND m.kind='gif' AND m.uploaded_at IS NOT NULL AND m.deleted_at IS NULL AND (m.retention_at IS NULL OR m.retention_at>now())) AS gif_uploaded,
      EXISTS(SELECT 1 FROM print_events p WHERE p.session_id=s.id AND p.status='confirmed') AS print_confirmed
      FROM sessions s LEFT JOIN frame_versions f ON f.id=s.frame_version_id
      LEFT JOIN shares sh ON sh.session_id=s.id AND sh.revoked_at IS NULL AND sh.expires_at>now()
      WHERE s.booth_id=${booth.id} AND s.tenant_id=${booth.tenant_id}
      ORDER BY s.created_at DESC,s.id DESC LIMIT 30` as {id:string;status:string;mode:string;created_at:string;photo_count:number|null;frame_name:string|null;share_expires_at:string|null;composite_uploaded:boolean;gif_uploaded:boolean;print_confirmed:boolean}[];
  }
  async issueLocalTestVoucher(booth:Booth,digest:string):Promise<void>{
    await this.sql`INSERT INTO vouchers(tenant_id,booth_id,code_digest,expires_at) VALUES(${booth.tenant_id},${booth.id},${digest},now()+interval '7 days')`;
  }
  async createSession(booth:Booth,clientId:string):Promise<Session>{
    const prior=await this.sql`SELECT * FROM sessions WHERE booth_id=${booth.id} AND client_session_id=${clientId}`;
    if(prior.length){const s=prior[0] as Session;if(s.mode!=='event')return fail(409,'session_conflict','Client session ID belongs to another authorization method');return s;}
    if(booth.session_mode==='disabled')return fail(403,'booth_disabled','Booth sessions are disabled');
    if(booth.session_mode==='paid')return fail(503,'paid_gateway_unconfigured','Paid sessions require a validated gateway integration');
    if(booth.session_mode==='voucher')return fail(403,'voucher_required','This booth requires a voucher');
    const rows=await this.sql`SELECT * FROM create_event_session(${booth.id},${clientId})`;
    if(!rows.length)return fail(409,'event_tokens_unavailable','Event mode is disabled or no event tokens remain');
    return rows[0] as Session;
  }
  async createVoucherSession(booth:Booth,clientId:string,digest:string):Promise<Session>{
    const rows=await this.sql`SELECT * FROM create_voucher_session(${booth.id},${clientId},${digest})`;
    if(!rows.length)return fail(403,'voucher_unavailable','Voucher is invalid, expired, out of scope, or already used');return rows[0] as Session;
  }
  async config(booth:Booth):Promise<BoothConfig>{
    const rows=await this.sql`SELECT * FROM booth_config_versions WHERE booth_id=${booth.id} AND version=${booth.config_version}`;
    return rows[0] as BoothConfig|undefined??fail(409,'configuration_unavailable','Booth configuration has not been published');
  }
  async frames(booth:Booth,version=booth.config_version):Promise<{id:string;name:string;manifest:unknown;manifest_sha256:string}[]>{
    return await this.sql`SELECT fv.id,fv.name,fv.manifest,fv.manifest_sha256 FROM booth_config_versions cv JOIN frame_versions fv ON fv.id=ANY(cv.frame_version_ids) WHERE cv.booth_id=${booth.id} AND cv.version=${version} AND fv.tenant_id=${booth.tenant_id} ORDER BY fv.name` as {id:string;name:string;manifest:unknown;manifest_sha256:string}[];
  }
  async acknowledgeConfig(booth:Booth,eventId:string,version:number,status:'applied'|'rejected',reason:string|null):Promise<{id:string;version:number;status:string;reason:string|null}>{
    const rows=await this.sql`SELECT * FROM record_config_apply(${booth.id},${eventId},${version},${status},${reason})`;
    const event=rows[0] as {id:string;version:number;status:string;reason:string|null}|undefined;
    if(!event)return fail(409,'configuration_conflict','Configuration version is unavailable');
    if(event.version!==version||event.status!==status||event.reason!==reason)return fail(409,'configuration_conflict','Config event ID was already reported differently');
    return event;
  }
  async session(id:string,booth:Booth):Promise<Session>{
    const rows=await this.sql`SELECT * FROM sessions WHERE id=${id} AND booth_id=${booth.id} AND tenant_id=${booth.tenant_id}`;
    return rows[0] as Session|undefined??fail(404,'session_not_found','Session was not found');
  }
  async selectFrame(session:Session,booth:Booth,frameId:string):Promise<Session>{
    const rows=await this.sql`UPDATE sessions SET frame_version_id=${frameId} WHERE id=${session.id} AND status='authorized' AND frame_version_id IS NULL AND EXISTS (SELECT 1 FROM booth_config_versions cv JOIN frame_versions fv ON fv.id=ANY(cv.frame_version_ids) WHERE cv.booth_id=${booth.id} AND cv.version=${session.config_version} AND fv.id=${frameId} AND fv.tenant_id=${booth.tenant_id}) RETURNING *`;
    if(rows.length)return rows[0] as Session;
    const current=(await this.sql`SELECT * FROM sessions WHERE id=${session.id}`)[0] as Session;
    if(current.frame_version_id===frameId)return current;
    return fail(409,'frame_selection_conflict','Frame is unavailable or a different frame was already selected');
  }
  async captured(session:Session,eventId:string,count:number):Promise<Session>{
    if(!session.frame_version_id)return fail(409,'frame_required','Select a frame before capture');
    const rows=await this.sql`UPDATE sessions SET status='captured',capture_event_id=${eventId},photo_count=${count},captured_at=now() WHERE id=${session.id} AND status='authorized' RETURNING *`;
    if(rows.length)return rows[0] as Session;
    const current=(await this.sql`SELECT * FROM sessions WHERE id=${session.id}`)[0] as Session;
    if(current.capture_event_id===eventId&&current.photo_count===count&&['captured','ready'].includes(current.status))return current;
    return fail(409,'invalid_session_state','Capture event conflicts with current session state');
  }
  async upload(session:Session,kind:'composite'|'gif',contentType:string,size:number,digest:string,rawToken:string):Promise<Upload>{
    const key=`tenant/${session.tenant_id}/booth/${session.booth_id}/session/${session.id}/${kind}/${crypto.randomUUID()}`;
    const hash=await sha256(rawToken);
    const rows=await this.sql`INSERT INTO media_uploads (session_id,kind,content_type,byte_size,sha256,object_key,upload_token_sha256,expires_at) VALUES (${session.id},${kind},${contentType},${size},${digest},${key},${hash},now()+interval '10 minutes') ON CONFLICT (session_id,kind) DO UPDATE SET expires_at=CASE WHEN media_uploads.uploaded_at IS NULL THEN now()+interval '10 minutes' ELSE media_uploads.expires_at END RETURNING *`;
    const upload=rows[0] as Upload;
    if(upload.sha256!==digest||upload.byte_size!==size||upload.content_type!==contentType)return fail(409,'media_conflict','Media slot already has different content');return upload;
  }
  async uploadByToken(raw:string):Promise<Upload>{const rows=await this.sql`SELECT * FROM media_uploads WHERE upload_token_sha256=${await sha256(raw)}`;return rows[0] as Upload|undefined??fail(404,'upload_not_found','Upload target was not found');}
  async markUploaded(id:string):Promise<void>{await this.sql`UPDATE media_uploads SET uploaded_at=COALESCE(uploaded_at,now()) WHERE id=${id}`;}
  async media(id:string):Promise<Upload[]>{return await this.sql`SELECT * FROM media_uploads WHERE session_id=${id} AND uploaded_at IS NOT NULL AND deleted_at IS NULL AND retention_at>now()` as Upload[];}
  async print(session:Session,eventId:string,jobId:string,status:string,spoolerId:string|null,occurredAt:string):Promise<{id:string;status:string}>{
    const rows=await this.sql`INSERT INTO print_events (session_id,event_id,client_job_id,status,spooler_job_id,occurred_at) VALUES (${session.id},${eventId},${jobId},${status},${spoolerId},${occurredAt}) ON CONFLICT (session_id,event_id) DO NOTHING RETURNING *`;
    const job=(rows[0]??(await this.sql`SELECT * FROM print_events WHERE session_id=${session.id} AND event_id=${eventId}`)[0]) as {id:string;status:string;client_job_id:string;spooler_job_id:string|null};
    if(job.status!==status||job.client_job_id!==jobId||job.spooler_job_id!==spoolerId)return fail(409,'print_conflict','Print event ID was already reported differently');return job;
  }
  async ready(session:Session):Promise<Session>{
    const rows=await this.sql`SELECT * FROM finalize_session(${session.id})`;
    if(rows.length)return rows[0] as Session;
    const current=(await this.sql`SELECT * FROM sessions WHERE id=${session.id}`)[0] as Session;
    if(current.status==='ready')return current;return fail(409,'delivery_pending','Verified photo, GIF and confirmed print are required');
  }
  async createShare(session:Session,hash:string):Promise<{expires_at:string}>{
    const rows=await this.sql`INSERT INTO shares (session_id,token_sha256,expires_at) VALUES (${session.id},${hash},(SELECT min(retention_at) FROM media_uploads WHERE session_id=${session.id})) ON CONFLICT (session_id) DO NOTHING RETURNING *`;
    const share=(rows[0]??(await this.sql`SELECT * FROM shares WHERE session_id=${session.id}`)[0]) as {token_sha256:string;expires_at:string};
    if(share.token_sha256!==hash)return fail(409,'share_conflict','Share token changed unexpectedly');
    if(new Date(share.expires_at).getTime()<=Date.now())return fail(410,'share_expired','Share link has expired');
    return share;
  }
  async share(raw:string):Promise<{session_id:string;expires_at:string}>{
    const rows=await this.sql`SELECT session_id,expires_at FROM shares WHERE token_sha256=${await sha256(raw)} AND revoked_at IS NULL AND expires_at>now()`;
    return rows[0] as {session_id:string;expires_at:string}|undefined??fail(404,'share_not_found','Share link is invalid or expired');
  }
  async expiredMedia(limit:number):Promise<{id:string;object_key:string}[]>{
    return await this.sql`SELECT id,object_key FROM media_uploads WHERE retention_at<=now() AND deleted_at IS NULL ORDER BY retention_at,id LIMIT ${limit}` as {id:string;object_key:string}[];
  }
  async markMediaDeleted(ids:string[]):Promise<void>{
    if(!ids.length)return;
    await this.sql`UPDATE media_uploads SET deleted_at=COALESCE(deleted_at,now()) WHERE id=ANY(${ids}::uuid[])`;
  }
}
