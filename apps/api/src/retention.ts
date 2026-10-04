import { Db } from './db';
import type { Env } from './platform';

export async function purgeExpiredMedia(env:Env,database?:Db):Promise<number>{
  const db=database??new Db(env);
  const expired=await db.expiredMedia(500);
  if(!expired.length)return 0;
  await env.PHOTOS.delete(expired.map(item=>item.object_key));
  await db.markMediaDeleted(expired.map(item=>item.id));
  return expired.length;
}
