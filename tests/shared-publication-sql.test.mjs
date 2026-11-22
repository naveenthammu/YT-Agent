// Exported SQL exercised in PostgreSQL (PGlite), without provider calls.
// Only pgcrypto digest and now() are substituted for an offline, fixed clock.
// This verifies sequential semantics, not multi-session lock contention or n8n.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PGlite}=require('../.validation/node_modules/@electric-sql/pglite');
const flows=Object.fromEntries(['00-database-setup','01-production','02-telegram-approval','03-publisher','04-render-and-review'].map(name=>[name,JSON.parse(fs.readFileSync(new URL('../workflows/'+name+'.json',import.meta.url),'utf8'))]));
const sql=(flow,name)=>flows[flow].nodes.find(node=>node.name===name).parameters.query;
const db=new PGlite();
let checks=0,sequence=0;
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const config={niche:'Synthetic SQL fixture',language:'en',telegramChatId:'-100123',approverIds:['42'],maxJobsPerDay:1,publishAfter:null,youtubeChannelId:'UC_test',instagramUserId:'123',instagramApiVersion:'v27.0',maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,mediaGeneration:'minimax_shared_v1',reuseVideoAcrossPlatforms:true,shotstackStage:'v1',shotstackVoice:'George',videoModel:'minimax-h3-text-to-video',videoResolution:'768p',shortDurationSeconds:30};
const fixture={title:'Original shared video',caption:'AI-generated educational visuals and narration.',visibility:'public',made_for_kids:false,scenes:[{narration:'Original fixture',onscreen_text:'Original',visual_prompt:'Slow camera motion',duration_seconds:10}],duration_seconds:30};
const assets=[{...fixture,format:'youtube_short',ordinal:0,target_id:config.youtubeChannelId},{...fixture,format:'instagram_reel',ordinal:1,target_id:config.instagramUserId,source_format:'youtube_short'}];
const media={url:'https://cdn.shotstack.io/au/v1/owner/shared.mp4',hash:'a'.repeat(64),bytes:4096,duration:30};
const quote={components:[{quote_id:'visual:0',kind:'video',credits:10},{quote_id:'voice:0',kind:'voice',credits:1}],video_credits:10,image_credits:0,voice_credits:1,generation_credits:11,render_estimate_credits:.5,margin_percent:25};
const run=(flow,name,args=[])=>db.query(sql(flow,name).replace(/\bnow\(\)/g,"current_setting('yt_agent.test_now')::timestamptz"),args);
const render=(name,args=[])=>run('04-render-and-review',name,args);
const row=async(table,id)=>(await db.query('SELECT * FROM yt_agent.'+table+' WHERE id=$1',[id])).rows[0];
const clock=iso=>db.query("SELECT set_config('yt_agent.test_now',$1,false)",[iso]);
const reserve=(job,asset,credits=15)=>render('Reserve Render Credits',[job.id,asset.id,credits,JSON.stringify({timeline:{tracks:[]},output:{format:'mp4'}}),1,'Mock quote; no paid request',JSON.stringify(quote)]);
async function reset(){await db.exec('TRUNCATE yt_agent.publications,yt_agent.assets,yt_agent.jobs,yt_agent.audit,yt_agent.budgets,yt_agent.credit_budgets CASCADE');await clock('2026-11-20T09:00:00Z');}
async function plan(custom={}){
 const job=(await db.query("INSERT INTO yt_agent.jobs(idempotency_key,status,config,telegram_chat_id,approver_ids) VALUES($1,'planning',$2::jsonb,'-100123','[\"42\"]') RETURNING *",['shared-'+(++sequence),JSON.stringify({...config,...custom})])).rows[0];
 const saved=(await run('01-production','Save Plan and Render Tasks',[job.id,JSON.stringify({topic:'Original shared fixture'}),JSON.stringify(assets)])).rows[0];
 check(Number(saved.assets),2);check(Number(saved.generated_assets),1);
 const stored=(await db.query('SELECT * FROM yt_agent.assets WHERE job_id=$1 ORDER BY ordinal',[job.id])).rows;
 // The database defaults use the real clock; make the poll eligible for fixed-clock tests.
 await db.query("UPDATE yt_agent.assets SET poll_after='2026-01-01' WHERE job_id=$1",[job.id]);
 return {job,master:stored[0],alias:stored[1]};
}
async function ready(p){
 check((await reserve(p.job,p.master)).rows[0].status,'submitting');
 await render('Save Render Submission',[p.master.id,p.job.id,'rendering','render-'+sequence,null]);
 check((await render('Save Ready Asset',[p.master.id,media.url,media.hash,media.bytes,media.duration])).rows.length,1);
}
async function preview(p,frozen,args={}){
 return render('Record Media Preview',[p.master.id,args.messageId??'98',args.hash??media.hash,args.url??media.url,args.bytes??media.bytes,args.jobId??p.job.id]);
}
try{
 await db.exec(sql('00-database-setup','Create YT-Agent Schema').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec("CREATE FUNCTION digest(text,text) RETURNS bytea IMMUTABLE LANGUAGE SQL AS $$ SELECT CASE WHEN $2='sha256' THEN sha256(convert_to($1,'UTF8')) ELSE NULL END $$;");
 await reset();
 const shared=await plan();
 check(shared.master.source_asset_id,null);check(shared.master.status,'planned');
 check(shared.alias.source_asset_id,shared.master.id);check(shared.alias.status,'shared_waiting');
 check((await run('01-production','Save Plan and Render Tasks',[shared.job.id,'{}',JSON.stringify(assets)])).rows.length,0,'Planner retry must not create more render tasks');
 check((await render('Claim Render Work')).rows[0].id,shared.master.id);
 check((await render('Claim Render Work')).rows.length,0);
 check((await reserve(shared.job,shared.alias)).rows.length,0,'Alias cannot spend generation credits');
 check((await run('03-publisher','Claim One Approved Publication')).rows.length,0);
 await ready(shared);
 const master=await row('assets',shared.master.id),alias=await row('assets',shared.alias.id);
 check(Date.parse(master.render_checkpoint.poll_deadline)-Date.parse(master.render_checkpoint.submitted_at),6*60*60*1000,'New renders retain six hourly polling opportunities');
 for(const field of ['status','media_url','sha256','bytes','render_id','render_stage'])check(alias[field],master[field],field+' copied to shared destination');
 check(Number(alias.render_credits),0);check(Number(master.render_credits),15);
 check(Number((await row('jobs',shared.job.id)).render_credits_reserved),15);
 check(Number((await db.query('SELECT reserved_credits FROM yt_agent.credit_budgets')).rows[0].reserved_credits),15);
 check((await reserve(shared.job,shared.master)).rows.length,0,'Reservation replay spends nothing');
 check((await render('Claim Render Work')).rows.length,0,'One generated master only');
 const frozen=(await render('Claim Complete Review')).rows[0];
 check(frozen.manifest.assets.length,2);
 check(frozen.manifest.assets.map(a=>a.format),['youtube_short','instagram_reel']);
 check(frozen.manifest.assets.map(a=>a.target_id),[config.youtubeChannelId,config.instagramUserId]);
 for(const field of ['media_url','sha256','bytes'])check(frozen.manifest.assets[0][field],frozen.manifest.assets[1][field]);
 check(frozen.manifest.assets[1].source_asset_id,shared.master.id);
 check((await render('Activate Stored Approval',[shared.job.id,'99',frozen.manifest_hash])).rows.length,0,'Buttons cannot activate before exact media preview');
 const approval=()=>run('02-telegram-approval','Apply Approval Atomically',[frozen.raw_token,'a','-100123','42','99','callback-shared']);
 check((await approval()).rows[0].changed,false);
 for(const wrong of [{messageId:''},{hash:'b'.repeat(64)},{url:media.url+'?changed=1'},{bytes:media.bytes+1},{jobId:'00000000-0000-4000-8000-000000000001'}])check((await preview(shared,frozen,wrong)).rows.length,0,'Wrong file or scope cannot mark previewed');
 check((await preview(shared,frozen)).rows.length,2,'One verified file previews both matching destination records');
 check((await row('assets',shared.master.id)).preview_message_id,(await row('assets',shared.alias.id)).preview_message_id);
 check((await render('Activate Stored Approval',[shared.job.id,'99',frozen.manifest_hash])).rows[0].status,'awaiting_approval');
 check((await run('03-publisher','Claim One Approved Publication')).rows.length,0,'Preview is not publication authorization');
 const approved=(await approval()).rows[0];check(approved.changed,true);check(Number(approved.publications_queued),2);
 check((await approval()).rows[0].changed,false,'Approval replay cannot publish twice');
 const first=(await run('03-publisher','Claim One Approved Publication')).rows[0];
 check((await run('03-publisher','Claim One Approved Publication')).rows.length,0,'Platforms publish serially per approved job');
 await run('03-publisher','Save Published Result',[first.publication_id,JSON.stringify({platform:first.asset.format.startsWith('youtube')?'youtube':'instagram',external_id:'offline-1',url:'https://example.test/post-1'})]);
 const second=(await run('03-publisher','Claim One Approved Publication')).rows[0];
 check(new Set([first.asset.format,second.asset.format]).size,2);check(new Set([first.asset.target_id,second.asset.target_id]).size,2);
 check(new Set([first.asset_id,second.asset_id]).size,2,'Separate publication rows retain platform identity');
 for(const field of ['media_url','sha256','bytes'])check(first.asset[field],second.asset[field],'Both platforms receive identical approved bytes');
 await run('03-publisher','Save Published Result',[second.publication_id,JSON.stringify({platform:second.asset.format.startsWith('youtube')?'youtube':'instagram',external_id:'offline-2',url:'https://example.test/post-2'})]);
 check((await row('jobs',shared.job.id)).status,'published');
 check((await run('03-publisher','Claim One Approved Publication')).rows.length,0);

 // A modified alias must not inherit a preview, and review must fail closed.
 await reset();const mismatch=await plan();await ready(mismatch);
 await db.query("UPDATE yt_agent.assets SET sha256=repeat('b',64) WHERE id=$1",[mismatch.alias.id]);
 check((await render('Claim Complete Review')).rows.length,0,'Ready alias with another file cannot be reviewed');
 await db.query('UPDATE yt_agent.assets SET sha256=$2 WHERE id=$1',[mismatch.alias.id,media.hash]);
 const review=(await render('Claim Complete Review')).rows[0];
 await db.query('UPDATE yt_agent.assets SET bytes=bytes+1 WHERE id=$1',[mismatch.alias.id]);
 check((await preview(mismatch,review)).rows.map(a=>a.id),[mismatch.master.id]);
 check((await row('assets',mismatch.alias.id)).preview_state,'pending');
 check((await render('Activate Stored Approval',[mismatch.job.id,'99',review.manifest_hash])).rows.length,0);
 await db.query("UPDATE yt_agent.jobs SET status='planned' WHERE id=$1",[mismatch.job.id]);
 await db.query("UPDATE yt_agent.assets SET status='planned' WHERE id=$1",[mismatch.alias.id]);
 check((await render('Claim Render Work')).rows.length,0,'Even a stale planned alias never starts generation');
 check((await reserve(mismatch.job,mismatch.alias)).rows.length,0);

 await reset();const missingAlias=await plan();
 await db.query('DELETE FROM yt_agent.assets WHERE id=$1',[missingAlias.alias.id]);
 await ready(missingAlias);
 check((await render('Claim Complete Review')).rows.length,0,'Shared configuration requires both platform destinations before review');
 check((await run('03-publisher','Claim One Approved Publication')).rows.length,0);

 // One attempt per IST calendar day, including manual retries and failures.
 await reset();await clock('2026-11-20T18:29:59Z');
 const claim=async key=>(await run('01-production','Reserve Job and Budget Slot',[key,JSON.stringify(config)])).rows[0].job;
 const beforeMidnight=await claim('daily-before-midnight');assert.ok(beforeMidnight);checks++;
 check(await claim('daily-before-midnight'),null,'Idempotency retry does not create another job');
 await db.query("UPDATE yt_agent.jobs SET status='failed' WHERE id=$1",[beforeMidnight.id]);
 check(await claim('manual-retry-same-day'),null,'Failure still consumes the generation attempt for the day');
 check(Number((await db.query("SELECT used_jobs FROM yt_agent.budgets WHERE key='production'")).rows[0].used_jobs),1);
 await clock('2026-11-20T18:30:01Z');
 check(await claim('daily-before-midnight'),null,'Old replay does not consume the new IST day');
 const afterMidnight=await claim('daily-after-midnight');assert.ok(afterMidnight);checks++;
 check(await claim('another-same-ist-day'),null);
 await clock('2026-11-21T00:00:01Z');
 check(await claim('utc-midnight-is-not-ist-midnight'),null);
 check(Number((await db.query("SELECT used_jobs FROM yt_agent.budgets WHERE key='production'")).rows[0].used_jobs),1);

 // Calendar month allowance is shared across jobs, retained on failure, replay safe.
 await reset();await clock('2026-11-30T18:29:59Z');
 const capped={maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:30};
 const monthA=await plan(capped),monthB=await plan(capped),monthC=await plan(capped);
 check((await reserve(monthA.job,monthA.master,15)).rows[0].status,'submitting');
 check((await reserve(monthA.job,monthA.master,15)).rows.length,0);
 await render('Save Render Submission',[monthA.master.id,monthA.job.id,'uncertain',null,'Offline simulated ambiguous submission']);
 check((await reserve(monthB.job,monthB.master,15)).rows[0].status,'submitting');
 check((await reserve(monthC.job,monthC.master,.01)).rows[0].status,'failed');
 let budgets=(await db.query('SELECT * FROM yt_agent.credit_budgets ORDER BY period')).rows;
 check(budgets.map(b=>[b.period,Number(b.reserved_credits)]),[['generation:2026-11',30]]);
 check(Number((await row('jobs',monthC.job.id)).render_credits_reserved),0);
 await clock('2026-11-30T18:30:01Z');
 check((await reserve(monthA.job,monthA.master,15)).rows.length,0,'Old reservation replay cannot spend the new month');
 const nextMonth=await plan(capped);check((await reserve(nextMonth.job,nextMonth.master,15)).rows[0].status,'submitting');
 budgets=(await db.query('SELECT * FROM yt_agent.credit_budgets ORDER BY period')).rows;
 check(budgets.map(b=>[b.period,Number(b.reserved_credits)]),[['generation:2026-11',30],['generation:2026-12',15]]);

 // Numeric SQL edge cases must fail before a paid render is submitted.
 await reset();
 for(const cost of [0,-1,'NaN','Infinity','-Infinity',16.01]){
  const invalid=await plan();check((await reserve(invalid.job,invalid.master,cost)).rows[0].status,'failed');
  check(Number((await row('jobs',invalid.job.id)).render_credits_reserved),0);
 }
 for(const invalidConfig of [{maxRenderCreditsPerJob:0},{maxRenderCreditsPerMonth:0},{maxRenderCreditsPerMonth:'500'},{maxRenderCreditsPerMonth:null},{mediaGeneration:'ai_video_v1'}]){
  const invalid=await plan(invalidConfig);check((await reserve(invalid.job,invalid.master)).rows[0].status,'failed');
 }
 check((await db.query('SELECT * FROM yt_agent.credit_budgets')).rows.length,0);
 console.log(JSON.stringify({checks,result:'PASS',provider_calls:0,coverage:['one generated file and two approved platform destinations','exact-file preview and publication gating','IST day/month boundaries and replay-safe credit accounting','invalid budgets and numeric edge cases'],limits:['pgcrypto digest shim and fixed now() clock','single-session semantics, not multi-session lock stress','not a live n8n import or provider test']},null,2));
}finally{await db.close();}
