export interface Env { DATABASE_URL: string; TOKEN_SIGNING_KEY: string; PHOTOS: R2Bucket; ASSETS?: Fetcher; APP_ENV?: string; MAX_MEDIA_BYTES?: string }
export class ApiError extends Error { constructor(readonly status:number,readonly code:string,message:string){super(message);} }
export const fail=(status:number,code:string,message:string):never=>{throw new ApiError(status,code,message);};
export const json=(value:unknown,status=200):Response=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const hex=(value:ArrayBuffer):string=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
export const sha256=async(value:string|ArrayBuffer):Promise<string>=>hex(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value));
export const signedToken=async(env:Env,purpose:string,id:string):Promise<string>=>{
  if(!env.TOKEN_SIGNING_KEY||env.TOKEN_SIGNING_KEY.length<32) return fail(503,'signing_unconfigured','Token signing is not configured');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TOKEN_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${purpose}:${id}`)));
};
export const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const body=async(request:Request):Promise<Record<string,unknown>>=>{
  const reader=request.body?.getReader();
  if(!reader)return fail(400,'invalid_json','JSON object required');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){
    const {value,done}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>65536){await reader.cancel();return fail(413,'body_too_large','JSON request must be at most 64 KiB');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let data:unknown;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail(400,'invalid_json','JSON object required');}
  if(!data||typeof data!=='object'||Array.isArray(data))return fail(400,'invalid_json','JSON object required');
  return data as Record<string,unknown>;
};
export const bearer=(request:Request):string=>{const v=request.headers.get('authorization');if(!v?.startsWith('Bearer ')||v.length<20||v.length>263)return fail(401,'unauthorized','Device bearer token required');return v.slice(7);};
