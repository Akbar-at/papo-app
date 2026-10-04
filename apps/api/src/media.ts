import { Db } from './db';
import { fail, json, sha256, type Env } from './platform';
export async function mediaRoutes(request:Request,url:URL,env:Env,db:Db):Promise<Response|undefined>{
  const uploadMatch=url.pathname.match(/^\/v1\/media-uploads\/([0-9a-f]{64})$/i);
  if(request.method==='PUT'&&uploadMatch){
    const upload=await db.uploadByToken(uploadMatch[1]);if(upload.uploaded_at)return new Response(null,{status:204});
    if(new Date(upload.expires_at).getTime()<Date.now())return fail(410,'upload_expired','Upload target expired');
    if(request.headers.get('content-type')!==upload.content_type)return fail(415,'invalid_content_type','Media content type differs from upload intent');
    const declared=Number(request.headers.get('content-length'));
    if(declared&&declared!==upload.byte_size)return fail(422,'invalid_size','Media byte size differs from upload intent');
    const bytes=await request.arrayBuffer();
    if(bytes.byteLength!==upload.byte_size||bytes.byteLength>Number(env.MAX_MEDIA_BYTES??20_000_000))return fail(422,'invalid_size','Media byte size differs from upload intent');
    const prefix=new Uint8Array(bytes),gifHeader=String.fromCharCode(...prefix.slice(0,6));
    const validJpeg=prefix.length>=3&&prefix[0]===255&&prefix[1]===216&&prefix[2]===255;
    if((upload.kind==='composite'&&!validJpeg)||(upload.kind==='gif'&&!['GIF87a','GIF89a'].includes(gifHeader)))return fail(422,'invalid_media_header','Media bytes do not match the declared format');
    if(await sha256(bytes)!==upload.sha256)return fail(422,'checksum_mismatch','Media SHA-256 differs from upload intent');
    await env.PHOTOS.put(upload.object_key,bytes,{httpMetadata:{contentType:upload.content_type},customMetadata:{sha256:upload.sha256}});
    await db.markUploaded(upload.id);return new Response(null,{status:204});
  }
  const shareMatch=url.pathname.match(/^\/g\/([0-9a-f]{64})(?:\/media\/(composite|gif))?$/i);
  if(request.method==='GET'&&shareMatch){
    const share=await db.share(shareMatch[1]),uploads=await db.media(share.session_id);
    if(!shareMatch[2])return json({session_id:share.session_id,expires_at:share.expires_at,media:uploads.map(u=>({kind:u.kind,url:`${url.origin}/g/${shareMatch[1]}/media/${u.kind}`}))});
    const media=uploads.find(u=>u.kind===shareMatch[2]);if(!media)return fail(404,'media_not_found','Media was not found');
    const object=await env.PHOTOS.get(media.object_key);if(!object)return fail(503,'media_unavailable','Media object is temporarily unavailable');
    return new Response(object.body,{headers:{'content-type':media.content_type,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  return undefined;
}
