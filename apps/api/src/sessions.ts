import { Db, type Booth } from './db';
import { body, fail, json, sha256, signedToken, uuid, type Env } from './platform';
export async function sessionRoutes(request:Request,url:URL,env:Env,db:Db,booth:Booth):Promise<Response|undefined>{
  if(request.method==='GET'&&url.pathname==='/v1/device/overview'){
    const sessions=await db.recentSessions(booth);
    return json({booth:{id:booth.id,name:booth.name,session_mode:booth.session_mode,desired_config_version:booth.config_version,applied_config_version:booth.applied_config_version},sessions:await Promise.all(sessions.map(async s=>({
      ...s,share_url:s.share_expires_at?`${url.origin}/g/${await signedToken(env,'share',s.id)}`:null
    })))});
  }
  if(request.method==='POST'&&url.pathname==='/v1/device/sessions'){
    const data=await body(request);
    if(!uuid(data.client_session_id))return fail(422,'invalid_session','client_session_id must be a UUID');
    if(!data.authorization||typeof data.authorization!=='object'||Array.isArray(data.authorization))return fail(422,'authorization_required','Authorization method is required');
    const auth=data.authorization as Record<string,unknown>;
    let session;
    if(auth.kind==='event')session=await db.createSession(booth,data.client_session_id);
    else if(auth.kind==='voucher'){
      if(typeof auth.code!=='string'||auth.code.length<6||auth.code.length>128)return fail(422,'invalid_voucher','Voucher code is required');
      session=await db.createVoucherSession(booth,data.client_session_id,await signedToken(env,'voucher',auth.code.trim().toUpperCase()));
    }else if(auth.kind==='payment')return fail(503,'paid_gateway_unconfigured','Paid sessions require a validated gateway integration');
    else return fail(422,'invalid_authorization','Expected event, voucher, or payment authorization');
    return json({session_id:session.id,client_session_id:session.client_session_id,status:session.status,mode:session.mode,price_idr:session.price_idr,config_version:session.config_version,capture_authorized:session.status==='authorized'},201);
  }
  if(request.method==='GET'&&url.pathname==='/v1/device/frames')return json({frames:await db.frames(booth),config_version:booth.config_version});
  if(request.method==='GET'&&url.pathname==='/v1/device/configuration'){
    const config=await db.config(booth);
    return json({desired_version:config.version,applied_version:booth.applied_config_version,session_mode:booth.session_mode,price_idr:config.price_idr,first_photo_timer_seconds:config.first_photo_timer_seconds,remaining_photo_timer_seconds:config.remaining_photo_timer_seconds,retake_limit:config.retake_limit,camera_settings:config.camera_settings,frames:await db.frames(booth,config.version)});
  }
  if(request.method==='POST'&&url.pathname==='/v1/device/config-applied'){
    const data=await body(request);
    if(!uuid(data.event_id)||!Number.isInteger(data.version)||Number(data.version)<1||(data.status!=='applied'&&data.status!=='rejected'))return fail(422,'invalid_config_ack','event_id, version and status are required');
    const reason=data.reason??null;
    if(reason!==null&&(typeof reason!=='string'||reason.length>512))return fail(422,'invalid_config_ack','Invalid rejection reason');
    if(data.status==='rejected'&&!reason)return fail(422,'invalid_config_ack','Rejection reason is required');
    const event=await db.acknowledgeConfig(booth,data.event_id,Number(data.version),data.status,reason);
    return json({event_id:data.event_id,version:event.version,status:event.status});
  }
  const matched=url.pathname.match(/^\/v1\/device\/sessions\/([0-9a-f-]+)(?:\/(authorization|frame|capture|media-uploads|finalize|prints))?$/i);
  if(!matched)return undefined;
  if(!uuid(matched[1]))return fail(404,'session_not_found','Session was not found');
  const session=await db.session(matched[1],booth),action=matched[2];
  if(request.method==='GET'&&!action)return json({session_id:session.id,status:session.status,mode:session.mode,frame_version_id:session.frame_version_id,config_version:session.config_version});
  if(request.method==='GET'&&action==='authorization')return json({session_id:session.id,capture_authorized:session.status==='authorized',status:session.status,mode:session.mode});
  if(request.method==='PUT'&&action==='frame'){
    const data=await body(request);if(!uuid(data.frame_version_id))return fail(422,'invalid_frame','frame_version_id must be a UUID');
    const selected=await db.selectFrame(session,booth,data.frame_version_id);return json({session_id:selected.id,frame_version_id:selected.frame_version_id,status:selected.status});
  }
  if(request.method==='POST'&&action==='capture'){
    const data=await body(request);if(!uuid(data.event_id)||!Number.isInteger(data.photo_count)||Number(data.photo_count)<1||Number(data.photo_count)>8)return fail(422,'invalid_capture','event_id UUID and photo_count 1–8 required');
    const result=await db.captured(session,data.event_id,Number(data.photo_count));return json({session_id:result.id,status:result.status});
  }
  if(request.method==='POST'&&action==='media-uploads'){
    if(!['captured','ready'].includes(session.status))return fail(409,'capture_pending','Capture must be reported first');
    const data=await body(request);if(data.kind!=='composite'&&data.kind!=='gif')return fail(422,'invalid_media_kind','Expected composite or gif');
    const contentType=data.kind==='composite'?'image/jpeg':'image/gif';
    if(data.content_type!==contentType||typeof data.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(data.sha256)||!Number.isInteger(data.byte_size)||Number(data.byte_size)<1||Number(data.byte_size)>Number(env.MAX_MEDIA_BYTES??20_000_000))return fail(422,'invalid_media','Content type, SHA-256 and byte size are required');
    const digest=data.sha256.toLowerCase(),uploadToken=await signedToken(env,'upload',`${session.id}:${data.kind}:${digest}`);
    const upload=await db.upload(session,data.kind,contentType,Number(data.byte_size),digest,uploadToken);
    return json({upload_id:upload.id,method:'PUT',upload_url:`${url.origin}/v1/media-uploads/${uploadToken}`,expires_at:upload.expires_at,uploaded:!!upload.uploaded_at});
  }
  if(request.method==='POST'&&action==='finalize'){
    const ready=await db.ready(session),shareToken=await signedToken(env,'share',ready.id),share=await db.createShare(ready,await sha256(shareToken));
    return json({session_id:ready.id,status:ready.status,share_url:`${url.origin}/g/${shareToken}`,share_expires_at:share.expires_at});
  }
  if(request.method==='POST'&&action==='prints'){
    if(!['captured','ready'].includes(session.status))return fail(409,'capture_pending','Capture must be reported first');
    const data=await body(request);
    if(!uuid(data.event_id)||!uuid(data.client_job_id)||!['submitted','confirmed','failed','uncertain'].includes(String(data.status))||typeof data.occurred_at!=='string'||!Number.isFinite(Date.parse(data.occurred_at)))return fail(422,'invalid_print','event_id, client_job_id, status and occurred_at are required');
    if(data.spooler_job_id!=null&&(typeof data.spooler_job_id!=='string'||data.spooler_job_id.length>128))return fail(422,'invalid_print','Invalid spooler_job_id');
    const print=await db.print(session,data.event_id,data.client_job_id,String(data.status),data.spooler_job_id as string|null??null,data.occurred_at);
    return json({print_job_id:print.id,status:print.status},201);
  }
  return undefined;
}
