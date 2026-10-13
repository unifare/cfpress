import {Env} from "../shared/types";
import {randomId} from "../shared/crypto";
import {now} from "../shared/repo";

export async function createRevision(env:Env, postId:string, authorId:string|null, locale:string, title:string, excerpt:string, content:string){
  const latest=await env.DB.prepare("SELECT MAX(version) AS version FROM post_revisions WHERE post_id=? AND locale=?").bind(postId,locale).first<any>();
  const version=Number(latest?.version||0)+1;
  await env.DB.prepare("INSERT INTO post_revisions(id,post_id,author_id,version,title,excerpt,content,locale,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(await randomId(),postId,authorId,version,title,excerpt,content,locale,now()).run();
  return version;
}
export async function autosave(env:Env,postId:string,userId:string,locale:string,b:any){
  await env.DB.prepare(`INSERT INTO post_autosaves(post_id,user_id,locale,title,excerpt,content,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(post_id,user_id,locale) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,content=excluded.content,updated_at=excluded.updated_at`)
    .bind(postId,userId,locale,String(b.title||""),String(b.excerpt||""),typeof b.content==="string"?b.content:JSON.stringify(b.content||[]),now()).run();
}
