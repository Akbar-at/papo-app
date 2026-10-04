import { Db } from './db';
import { mediaRoutes } from './media';
import { sessionRoutes } from './sessions';
import { purgeExpiredMedia } from './retention';
import { ApiError, bearer, json, type Env } from './platform';
import { adminRoutes } from './admin';
import { authRoutes } from './auth';
import { docsRoute } from './docs';
import { testUi } from './test-ui';
async function handleRequest(request:Request,env:Env,database?:Db,clientIp?:string):Promise<Response>{
  const url=new URL(request.url);
  try{
    if(request.method==='GET'&&env.ASSETS&&['/','/admin','/app.js','/styles.css'].includes(url.pathname))return env.ASSETS.fetch(new Request(new URL(url.pathname==='/admin'?'/':url.pathname,url),request));
    if(request.method==='GET'&&url.pathname==='/healthz')return json({ok:true});
    if(request.method==='GET'&&['/test/booth','/test/status'].includes(url.pathname)&&['local','development'].includes(env.APP_ENV??''))return new Response(testUi,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}});
    const docsResponse=docsRoute(request,url.pathname);
    if(docsResponse)return docsResponse;
    const db=database??new Db(env);
    const authResponse=await authRoutes(request,url,env,db,clientIp);if(authResponse)return authResponse;
    const publicResponse=await mediaRoutes(request,url,env,db);
    if(publicResponse)return publicResponse;
    if(url.pathname.startsWith('/v1/admin/')){const response=await adminRoutes(request,url,env,db);if(response)return response;}
    if(url.pathname.startsWith('/v1/device/')){const booth=await db.boothForToken(bearer(request));const response=await sessionRoutes(request,url,env,db,booth);if(response)return response;}
    return json({error:{code:'not_found',message:'Route was not found'}},404);
  }catch(cause){
    if(cause instanceof ApiError)return json({error:{code:cause.code,message:cause.message}},cause.status);
    const safePath=url.pathname.replace(/^\/v1\/media-uploads\/[^/]+/,'/v1/media-uploads/[redacted]').replace(/^\/g\/[^/]+/,'/g/[redacted]');
    console.error(JSON.stringify({event:'request_failed',method:request.method,path:safePath,error:cause instanceof Error?cause.name:'unknown'}));
    return json({error:{code:'internal_error',message:'Unexpected server error'}},500);
  }
}
export async function handle(request:Request,env:Env,database?:Db,clientIp?:string):Promise<Response>{
  const result=await handleRequest(request,env,database,clientIp);
  const response=new Response(result.body,{status:result.status,headers:result.headers});
  response.headers.set('x-content-type-options','nosniff');
  response.headers.set('referrer-policy','no-referrer');
  if(response.headers.get('content-type')?.includes('text/html')&&!response.headers.has('content-security-policy'))
    response.headers.set('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return response;
}
export default {
  fetch(request:Request,env:Env):Promise<Response>{return handle(request,env,undefined,request.headers.get('cf-connecting-ip')??undefined);},
  scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):void{ctx.waitUntil(purgeExpiredMedia(env));}
} satisfies ExportedHandler<Env>;
