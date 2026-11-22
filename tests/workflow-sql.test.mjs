// Offline PostgreSQL semantics through PGlite. No provider accounts or requests.
// The pgcrypto text/SHA256 function is emulated with PostgreSQL's built-in SHA256.
// This does not verify real multi-session locks or n8n importing/runtime behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const {PGlite} = require('../.validation/node_modules/@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = name => JSON.parse(fs.readFileSync(path.join(root,'workflows',name),'utf8'));
const query = (file,name) => workflow(file).nodes.find(n=>n.name===name).parameters.query;
const db = new PGlite();
let checks = 0;
try {
 await db.exec(query('00-database-setup.json','Create YT-Agent Schema').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
 await db.exec("CREATE FUNCTION digest(text,text) RETURNS bytea IMMUTABLE LANGUAGE SQL AS $$ SELECT CASE WHEN $2='sha256' THEN sha256(convert_to($1,'UTF8')) ELSE NULL END $$;");
 const config={niche:'Synthetic test',language:'en',telegramChatId:'-100123',approverIds:['42'],maxJobsPerDay:99,publishAfter:null,youtubeChannelId:'UC_test',instagramUserId:'123',instagramApiVersion:'v27.0'};
 const claimQ=query('01-production.json','Reserve Job and Budget Slot');
 const saveQ=query('01-production.json','Save Plan and Render Tasks');
 const decisionQ=query('02-telegram-approval.json','Apply Approval Atomically');
 const publishQ=query('03-publisher.json','Claim One Approved Publication');
 const savePublishedQ=query('03-publisher.json','Save Published Result');
 const uncertainQ=query('03-publisher.json','Record Uncertain Outcome');
 let seq=0;
 async function ready(formats=['youtube_short','instagram_reel'], opts={}) {
  const idem='sql-test-'+(++seq);
  const r=await db.query(claimQ,[idem,JSON.stringify(config)]);
  const job=r.rows[0].job;
  assert.ok(job.id);
  const assets=formats.map((format,ordinal)=>({format,ordinal,title:'Original fixture',caption:'Approved caption',target_id:format.startsWith('youtube')?'UC_test':'123',visibility:format.startsWith('youtube')?'private':'public',made_for_kids:false,scenes:[{narration:'Test',onscreen_text:'Test',visual_prompt:'Original text'}],duration_seconds:15}));
  await db.query(saveQ,[job.id,JSON.stringify({topic:'Fixture topic'}),JSON.stringify(assets)]);
  await db.query("UPDATE yt_agent.assets SET status='ready',media_url='https://cdn.shotstack.io/test/fixture.mp4',sha256=repeat('a',64),bytes=123 WHERE job_id=$1",[job.id]);
  const manifest=(await db.query("SELECT jsonb_build_object('job_id',$1::text,'revision',1,'publish_after',$2::text,'assets',jsonb_agg(jsonb_build_object('id',id,'format',format,'title',title,'caption',caption,'target_id',target_id,'visibility',visibility,'made_for_kids',made_for_kids,'contains_synthetic_media',true,'media_url',media_url,'sha256',sha256,'bytes',bytes) ORDER BY ordinal)) AS manifest FROM yt_agent.assets WHERE job_id=$1::uuid",[job.id,opts.future?'2099-01-01T00:00:00Z':null])).rows[0].manifest;
  const token='11111111-1111-4111-8111-'+String(seq).padStart(12,'0');
  await db.query("UPDATE yt_agent.jobs SET status='awaiting_approval',manifest=$2::jsonb,manifest_hash=encode(digest(($2::jsonb)::text,'sha256'),'hex'),approval_token_hash=encode(digest($3,'sha256'),'hex'),approval_expires=now()+interval '1 day',telegram_message_id='99' WHERE id=$1::uuid",[job.id,JSON.stringify(manifest),token]);
  return {job,token,idem,manifest};
 }
 const a=await ready();
 assert.equal((await db.query(claimQ,[a.idem,JSON.stringify(config)])).rows[0].job,null); checks++;
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 assert.equal((await db.query(decisionQ,[a.token,'a','-100123','999','99','cb-wrong'])).rows[0].changed,false); checks++;
 assert.equal((await db.query(decisionQ,[a.token,'a','-100999','42','99','cb-chat'])).rows[0].changed,false); checks++;
 assert.equal((await db.query(decisionQ,[a.token,'a','-100123','42','98','cb-msg'])).rows[0].changed,false); checks++;
 const approved=(await db.query(decisionQ,[a.token,'a','-100123','42','99','cb-ok'])).rows[0];
 assert.equal(approved.changed,true); assert.equal(Number(approved.publications_queued),2); checks++;
 assert.equal((await db.query(decisionQ,[a.token,'a','-100123','42','99','cb-replay'])).rows[0].changed,false); checks++;
 const first=(await db.query(publishQ)).rows[0]; assert.ok(first.publication_id); checks++;
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 await db.query(savePublishedQ,[first.publication_id,JSON.stringify({platform:'youtube',external_id:'mock-1',url:'https://youtu.be/mock-1'})]);
 const second=(await db.query(publishQ)).rows[0]; assert.ok(second.publication_id); checks++;
 await db.query(savePublishedQ,[second.publication_id,JSON.stringify({platform:'instagram',external_id:'mock-2',url:'https://instagram.com/p/mock'})]);
 assert.equal((await db.query('SELECT status FROM yt_agent.jobs WHERE id=$1',[a.job.id])).rows[0].status,'published'); checks++;
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 const b=await ready(['youtube_short']);
 await db.query("UPDATE yt_agent.jobs SET manifest=jsonb_set(manifest,'{assets,0,caption}','\"Changed after preview\"'::jsonb) WHERE id=$1",[b.job.id]);
 assert.equal((await db.query(decisionQ,[b.token,'a','-100123','42','99','cb-tamper'])).rows[0].changed,false); checks++;
 const c=await ready(['youtube_short']);
 await db.query("UPDATE yt_agent.jobs SET approval_expires=now()-interval '1 second' WHERE id=$1",[c.job.id]);
 assert.equal((await db.query(decisionQ,[c.token,'a','-100123','42','99','cb-expired'])).rows[0].changed,false); checks++;
 const d=await ready(['youtube_short']);
 assert.equal((await db.query(decisionQ,[d.token,'r','-100123','42','99','cb-reject'])).rows[0].status,'rejected'); checks++;
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 const e=await ready(['youtube_short','instagram_reel']);
 await db.query(decisionQ,[e.token,'a','-100123','42','99','cb-e']);
 const pending=(await db.query(publishQ)).rows[0];
 await db.query(uncertainQ,[pending.publication_id,'Simulated network ambiguity']);
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 assert.equal((await db.query('SELECT status FROM yt_agent.jobs WHERE id=$1',[e.job.id])).rows[0].status,'uncertain'); checks++;
 const future=await ready(['youtube_short'],{future:true});
 await db.query(decisionQ,[future.token,'a','-100123','42','99','cb-future']);
 assert.equal((await db.query(publishQ)).rows.length,0); checks++;
 const limit=(await db.query('SELECT used_jobs FROM yt_agent.budgets WHERE key=$1',['production'])).rows[0].used_jobs;
 assert.equal((await db.query(claimQ,['new-over-limit',JSON.stringify({...config,maxJobsPerDay:limit})])).rows[0].job,null); checks++;
 console.log(JSON.stringify({checks,sql_engine:'PGlite PostgreSQL 18.7',provider_calls:0,result:'PASS',limits:['pgcrypto digest wrapper substituted','single-session semantics, not multi-session stress','not an n8n import or live provider test']},null,2));
} finally { await db.close(); }
