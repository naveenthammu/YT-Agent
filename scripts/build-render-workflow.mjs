// Authoring helper only. The exported workflow is standalone; no script is deployed.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const nodes=[], connections={};
const credentials={postgres:{name:'YT-Agent Database'},telegramApi:{name:'YT-Agent Telegram'},httpHeaderAuth:{name:'YT-Agent Shotstack'}};
const add=(name,type,version,parameters,position,extras={})=>{const node={id:randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:version,parameters,position,...extras};nodes.push(node);return node;};
const link=(from,to,output=0)=>{connections[from]??={main:[]};while(connections[from].main.length<=output)connections[from].main.push([]);connections[from].main[output].push({node:to,type:'main',index:0});};
const code=(name,fn,position,notes)=>add(name,'code',2,{mode:'runOnceForAllItems',language:'javaScript',jsCode:fn.toString().slice(fn.toString().indexOf('{')+1,fn.toString().lastIndexOf('}'))},position,notes?{notes,notesInFlow:true}:{});
const sql=(name,query,params,position)=>add(name,'postgres',2.6,{operation:'executeQuery',query,options:{queryReplacement:params||'={{ [] }}',queryBatching:'independently'}},position,{credentials:{postgres:credentials.postgres},retryOnFail:false});
const conditional=(name,expression,position)=>add(name,'if',2.2,{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:randomUUID(),leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},position);
const http=(name,url,position,{method='GET',body,auth=true,binary=false,uncertain=false}={})=>{
 const parameters={method,url,options:{timeout:120000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:binary?'file':'json',...(binary?{outputPropertyName:'media'}:{})}}}};
 if(auth)Object.assign(parameters,{authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth'});
 if(body)Object.assign(parameters,{sendBody:true,contentType:'json',specifyBody:'json',jsonBody:body});
 return add(name,'httpRequest',4.2,parameters,position,{...(auth?{credentials:{httpHeaderAuth:credentials.httpHeaderAuth}}:{}),retryOnFail:false,onError:uncertain?'continueRegularOutput':'stopWorkflow'});
};
const telegram=(name,operation,parameters,position)=>add(name,'telegram',1.2,{resource:'message',operation,replyMarkup:'none',...parameters},position,{credentials:{telegramApi:credentials.telegramApi},retryOnFail:false,onError:'stopWorkflow'});
const hash=(name,position)=>add(name,'crypto',2,{action:'hash',type:'SHA256',binaryData:true,binaryPropertyName:'media',dataPropertyName:'sha256',encoding:'hex'},position);

function buildOriginalEdit(){
 const a=$input.first().json,c=a.config;
 if(c?.mediaGeneration!=='minimax_shared_v1')throw new Error('This planned job uses an old generation configuration. Create a new job with mediaGeneration=minimax_shared_v1 and a fresh shared video plan before rendering.');
 if(a.source_asset_id!=null||a.format!=='youtube_short'||c.reuseVideoAcrossPlatforms!==true)throw new Error('Only the canonical YouTube Short can generate the shared video; Instagram aliases cannot render');
 for(const key of ['maxRenderCreditsPerJob','maxRenderCreditsPerMonth'])if(typeof c[key]!=='number'||!Number.isFinite(c[key])||c[key]<=0)throw new Error('Set a positive finite '+key+' before rendering');
 if(!['stage','v1'].includes(c.shotstackStage)||c.shotstackRegion!=='au')throw new Error('Supported Shotstack stages are stage/v1 in region au');
 if(c.videoModel!=='minimax-h3-text-to-video'||c.videoResolution!=='768p')throw new Error('Use MiniMax Hailuo 3 text-to-video with 768p source video');
 if(typeof c.visualStyle!=='string'||!c.visualStyle.trim()||c.visualStyle.length>500)throw new Error('Set a nonempty visualStyle of at most 500 characters');
 if(!c.shotstackVoice||!String(c.shotstackVoice).trim()||!c.language)throw new Error('Choose shotstackVoice and language explicitly before voice generation');
 if(!Number.isInteger(c.maxScenes)||c.maxScenes<1||c.maxScenes>12||!Array.isArray(a.scenes)||!a.scenes.length||a.scenes.length>c.maxScenes)throw new Error('Invalid or excessive AI shot count (maximum twelve)');
 if(!Number.isInteger(a.duration_seconds)||a.duration_seconds<10||a.duration_seconds>60)throw new Error('Shared video duration must be 10..60 seconds');
 const scenes=a.scenes;
 for(const scene of scenes){
   if(!Number.isInteger(scene.duration_seconds)||scene.duration_seconds<5||scene.duration_seconds>15)throw new Error('MiniMax shots require explicit integer duration_seconds of 5..15. Create a new job to replace legacy planned scenes.');
   if(typeof scene.visual_prompt!=='string'||!scene.visual_prompt.trim()||scene.visual_prompt.length>1000)throw new Error('Each AI shot needs a nonempty visual_prompt of at most 1000 characters');
   if(typeof scene.onscreen_text!=='string'||scene.onscreen_text.length>240||typeof scene.narration!=='string'||!scene.narration.trim())throw new Error('Optional captions must fit 240 characters; video narration must be nonempty');
 }
 if(scenes.reduce((total,scene)=>total+scene.duration_seconds,0)!==Number(a.duration_seconds))throw new Error('AI shot durations must exactly match the requested asset duration. Create a new job with a fresh shot plan.');
 const narration=scenes.map(scene=>scene.narration.trim()).join('\n\n');
 if(narration.length>4096||narration.split(/\s+/).length>Math.ceil(a.duration_seconds*2.7))throw new Error('Narration exceeds the bounded character/word duration limit');
 const width=720,height=1280,seconds=a.duration_seconds;
 const speech={type:'audio',prompt:narration,model:'elevenlabs-multilingual-v2',options:{voice:String(c.shotstackVoice),language:String(c.language).split('-')[0].toLowerCase()}};
 const captionClips=[],visualClips=[],quote_requests=[];
 let elapsed=0;
 for(let i=0;i<scenes.length;i++){
   const scene=scenes[i],length=scene.duration_seconds,timing={start:elapsed,length};
   const visual={type:'video',prompt:scene.visual_prompt.trim()+'\nVisual style: '+c.visualStyle.trim(),model:c.videoModel,volume:0,
     options:{aspectRatio:'9:16',resolution:c.videoResolution,enhancePrompt:false}};
   visualClips.push({asset:visual,...timing});
   // Quote accepts generation fields only; volume belongs to the final VideoAsset.
   const {volume,...generationAsset}=visual;
   quote_requests.push({quote_id:'visual:'+i,kind:'video',quote_body:{asset:generationAsset,length}});
   if(scene.onscreen_text.trim()){
     const fontSize=Math.min(26,Math.max(16,Math.floor(Math.sqrt(width*.82*height*.12/(Math.max(1,Array.from(scene.onscreen_text).length)*1.5)))));
     captionClips.push({asset:{type:'rich-text',text:scene.onscreen_text,font:{size:fontSize,weight:'700',color:'#FFFFFF'},align:{horizontal:'center',vertical:'middle'},style:{lineHeight:1.15}},...timing,width:Math.round(width*.82),height:Math.round(height*.13),position:'center',offset:{x:0,y:-0.36}});
   }
   elapsed+=length;
 }
 const tracks=[...(captionClips.length?[{clips:captionClips}]:[]),{clips:visualClips}];
 tracks.push({clips:[{alias:'voice',asset:speech,start:0,length:'auto'}]});
 quote_requests.push({quote_id:'voice:0',kind:'voice',quote_body:{asset:speech}});
 const edit={timeline:{background:'#000000',tracks},output:{format:'mp4',size:{width,height},quality:'medium',fps:24}};
 return [{json:{...a,has_voice:true,edit,quote_requests,voice_credits:0,render_estimate_credits:seconds/60,
   cost_note:'One shared video: all MiniMax shots and voice quotes plus PAYG render estimate (1 credit/minute), with 25% margin. Estimate is not a provider billing cap.'}}];
}

function prepareGenerationQuotes(){
 const built=$input.first().json;
 if(!Array.isArray(built.quote_requests)||!built.quote_requests.length)throw new Error('No generation components were prepared; no paid render submitted');
 return built.quote_requests.map(request=>({json:{...request,shotstack_stage:built.config.shotstackStage},pairedItem:{item:0}}));
}

function priceAllGenerationAndRender(){
 const built=$('Build Original Edit').first().json,responses=$input.all(),expected=built.quote_requests;
 if(responses.length!==expected.length)throw new Error('Incomplete generation quote responses; no paid render submitted');
 const byId=new Map(expected.map(request=>[request.quote_id,request])),seen=new Set(),components=[];
 if(byId.size!==expected.length)throw new Error('Duplicate prepared generation quote IDs; no paid render submitted');
 let voice=0,video=0,image=0;
 for(let i=0;i<responses.length;i++){
   // itemMatching follows n8n paired-item provenance, including reordered items.
   const request=$('Prepare Generation Quotes').itemMatching(i).json,planned=byId.get(request.quote_id),quote=responses[i].json;
   if(!planned||seen.has(request.quote_id)||JSON.stringify(request.quote_body)!==JSON.stringify(planned.quote_body)||request.kind!==planned.kind)throw new Error('Generation quote response pairing is missing or duplicated; no paid render submitted');
   if(typeof quote.credits!=='number'||!Number.isFinite(quote.credits)||quote.credits<0||quote.ceiling!==false)throw new Error('Shotstack quote missing, invalid or only a ceiling; no paid render submitted');
   seen.add(request.quote_id);
   components.push({quote_id:request.quote_id,kind:request.kind,credits:quote.credits});
   if(request.kind==='voice')voice+=quote.credits;else if(request.kind==='video')video+=quote.credits;else if(request.kind==='image')image+=quote.credits;else throw new Error('Unsupported generation quote kind');
 }
 const generation=voice+video+image,estimate=Math.ceil((generation+built.render_estimate_credits)*1.25*1000000)/1000000;
 if(!Number.isFinite(estimate)||estimate<=0)throw new Error('Invalid total generation/render estimate; no paid render submitted');
 return [{json:{...built,voice_credits:voice,reserved_credits:estimate,generation_quote_breakdown:{components,video_credits:video,image_credits:image,voice_credits:voice,generation_credits:generation,render_estimate_credits:built.render_estimate_credits,margin_percent:25}}}];
}

function submittedOutcome(){
 const claim=$('Reserve Render Credits').first().json,response=$input.first().json;
 const id=response.response?.id;
 const accepted=response.success===true&&typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
 return [{json:{id:claim.id,job_id:claim.job_id,render_id:accepted?id:null,status:accepted?'rendering':'uncertain',error:accepted?null:'Render submission response missing or ambiguous. Reconcile with Shotstack before retrying; a charge may have occurred.'}}];
}

function classifyRenderStatus(){
 const a=$('Claim Render Work').first().json,r=$input.first().json.response;
 const statuses=['queued','fetching','preprocessing','rendering','generating','saving','done','failed'];
 if(!r||r.id!==a.render_id||!statuses.includes(r.status))throw new Error('Unexpected Shotstack status response; keep the existing render ID');
 const failed=r.status==='failed';
 return [{json:{...a,done:r.status==='done',status:failed?'failed':'rendering',error:failed?String(r.error||'Shotstack render failed').slice(0,1500):null,render_status:r.status}}];
}

function selectHostedAsset(){
 const a=$('Claim Render Work').first().json,result=$input.first().json,ext=a.format==='instagram_image'?'jpg':'mp4';
 if(!Array.isArray(result.data))throw new Error('Unexpected Shotstack Serve response');
 const item=result.data.map(value=>value.attributes).find(value=>value&&value.renderId===a.render_id&&value.filename===a.render_id+'.'+ext&&value.status==='ready');
 if(!item)return [{json:{...a,hosted_ready:false,status:'rendering',error:null}}];
 // The n8n secure Code runner has no global URL. Match only the complete,
 // documented CDN shape; credentials, ports, escapes, query and fragment fail.
 const match=typeof item.url==='string'&&/^https:\/\/cdn\.shotstack\.io\/au\/(stage|v1)\/([A-Za-z0-9_-]+)\/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\.(jpg|mp4)$/.exec(item.url);
 if(!match||match[1]!==a.render_stage||match[3]!==a.render_id||match[4]!==ext)throw new Error('Hosted media URL is not the expected immutable Shotstack render');
 return [{json:{...a,hosted_ready:true,media_url:item.url}}];
}

function validateRenderedMedia(){
 const a=$('Select Hosted Asset').first().json,response=$input.first().json,r=response.response||{};
 const streams=Array.isArray(r.streams)?r.streams:[],v=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
 const dimensions={youtube_long:[1280,720],youtube_short:[720,1280],instagram_reel:[720,1280],instagram_image:[1080,1350]};
 const image=a.format==='instagram_image',bytes=Number(r.format?.size),seconds=Number(r.format?.duration),[width,height]=dimensions[a.format];
 let error=null;
 if(response.success!==true||!v||v.width!==width||v.height!==height)error='Rendered dimensions do not match the requested format';
 else if(image?v.codec_name!=='mjpeg':v.codec_name!=='h264'||audio?.codec_name!=='aac')error='Rendered media must be JPEG or H264/AAC MP4';
 else if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>(image?9000000:45000000))error=image?'Image exceeds the 9 MB review limit. Regenerate at lower quality.':'Video exceeds the 45 MB review limit. Regenerate with shorter duration or lower output quality; no approval issued.';
 else if(!image&&(!Number.isFinite(seconds)||seconds<Number(a.duration_seconds)-0.5||seconds>Number(a.duration_seconds)+0.5))error='Rendered video is truncated or exceeds the configured duration. Create a new job with a corrected narration/shot plan; no approval issued.';
 return [{json:{...a,valid:!error,status:error?'failed':'rendering',error,expected_bytes:bytes,actual_duration_seconds:image?0:seconds}}];
}

async function inspectDownloadedMedia(){
 const item=$input.first(),a=$('Validate Rendered Media').first().json;
 const data=await this.helpers.getBinaryDataBuffer(0,'media');
 let error=null;
 if(!data.length||data.length!==a.expected_bytes||data.length>(a.format==='instagram_image'?9000000:45000000))error='Downloaded media size differs from its verified render metadata';
 if(!/^[a-f0-9]{64}$/i.test(item.json.sha256||''))error='SHA256 was not computed from the actual downloaded media';
 return [{json:{...a,sha256:item.json.sha256,bytes:data.length,valid:!error,status:error?'failed':'ready',error},binary:item.binary}];
}

function buildOrderedReviewTasks(){
 const job=$input.first().json,assets=job.manifest?.assets;
 if(!Array.isArray(assets)||assets.length<1||assets.length>4)throw new Error('Review manifest must contain 1..4 assets');
 const byId=new Map(assets.map(asset=>[asset.id,asset]));
 if(byId.size!==assets.length)throw new Error('Review manifest has duplicate asset IDs');
 for(const asset of assets){
   if(asset.source_asset_id!=null){
     const master=byId.get(asset.source_asset_id);
     if(!master||master.source_asset_id!=null||master.format!=='youtube_short'||asset.format!=='instagram_reel'||master.media_url!==asset.media_url||master.sha256!==asset.sha256||String(master.bytes)!==String(asset.bytes))throw new Error('Shared review media differs from its canonical source; no approval issued');
   }
 }
 const tasks=[];
 const ordered=assets.filter(asset=>asset.source_asset_id==null).flatMap(master=>[master,...assets.filter(asset=>asset.source_asset_id===master.id)]);
 for(const asset of ordered){
   if(!/^[a-f0-9]{64}$/i.test(asset.sha256)||!Number.isSafeInteger(Number(asset.bytes))||Number(asset.bytes)<=0||Number(asset.bytes)>(asset.format==='instagram_image'?9000000:45000000))throw new Error('Review requires bounded media and complete hashes');
   const match=typeof asset.media_url==='string'&&/^https:\/\/cdn\.shotstack\.io\/au\/(stage|v1)\/([A-Za-z0-9_-]+)\/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\.(jpg|mp4)$/.exec(asset.media_url);
   if(!match||!['youtube_long','youtube_short','instagram_reel','instagram_image'].includes(asset.format)||match[4]!==(asset.format==='instagram_image'?'jpg':'mp4'))throw new Error('Review media must use the verified Shotstack CDN');
   const context={...asset,job_id:job.id,revision:job.revision,telegram_chat_id:job.telegram_chat_id};
   if(asset.source_asset_id==null)tasks.push({json:{...context,task:'media'}});
   const text='Job '+job.id+' / revision '+job.revision+'\nAsset '+asset.id+'\nFormat: '+asset.format+'\nDestination account: '+asset.target_id+'\nVisibility: '+asset.visibility+'\nMade for kids: '+asset.made_for_kids+'\nSynthetic media: '+asset.contains_synthetic_media+'\nTitle:\n'+asset.title+'\n\nExact publishing caption:\n'+asset.caption+'\n\nSHA256: '+asset.sha256+'\nBytes: '+asset.bytes+'\nPublication after: '+(job.manifest.publish_after||'approval')+'\nEstimated job render/generation credits reserved: '+String(job.render_credits_reserved??'see database')+' (all AI video/image and voice quotes plus render estimate and 25% margin; not a billing cap).\n';
   // Escape rather than interpret arbitrary generated caption markup. Each chunk
   // is bounded after entity expansion and renders as the exact plain text.
   let chunk='';
   for(const character of text){const escaped=character==='&'?'&amp;':character==='<'?'&lt;':character==='>'?'&gt;':character;if(chunk.length+escaped.length>3500){tasks.push({json:{...context,task:'metadata',text:chunk}});chunk='';}chunk+=escaped;}
   if(chunk)tasks.push({json:{...context,task:'metadata',text:chunk}});
 }
 return tasks;
}

async function verifyReviewBytes(){
 const item=$input.first(),task=$('Loop Review Tasks').item.json;
 const data=await this.helpers.getBinaryDataBuffer(0,'media');
 if(item.json.sha256!==task.sha256||data.length!==Number(task.bytes))throw new Error('Review media changed after the manifest was frozen; no approval buttons will be sent');
 item.binary.media.fileName=task.format+(task.format==='instagram_image'?'.jpg':'.mp4');
 return [{json:{...task},binary:item.binary}];
}

add('Run Render And Review','manualTrigger',1,{},[0,0]);
add('Render And Review Hourly','scheduleTrigger',1.2,{rule:{interval:[{field:'minutes',minutesInterval:60}]}},[0,180],{notes:'Inactive on import. Hourly polling reduces idle n8n Cloud executions; finished media may wait up to an hour for review. Activate only after workflow 00, workflow 01 configuration, and all credentials are ready.',notesInFlow:true});
sql('Expire Uncertain Work',`WITH stale_assets AS (
 UPDATE yt_agent.assets SET status='uncertain',error='Render submission interrupted; reconcile in Shotstack before retrying',updated_at=now()
 WHERE status='submitting' AND updated_at<now()-interval '20 minutes' RETURNING job_id
), timed_out AS (
 UPDATE yt_agent.assets SET status='failed',error='Render exceeded its stored polling deadline; inspect the existing Shotstack render before regeneration',poll_lease_until=NULL,updated_at=now()
 WHERE status='rendering' AND COALESCE((render_checkpoint->>'poll_deadline')::timestamptz,created_at+interval '2 hours')<now() RETURNING job_id
), stale_jobs AS (
 UPDATE yt_agent.jobs SET status='uncertain',error='An interrupted render or Telegram notification needs operator reconciliation',approval_token_hash=NULL,updated_at=now()
 WHERE id IN(SELECT job_id FROM stale_assets) OR (status='notifying' AND updated_at<now()-interval '30 minutes') RETURNING id
), failed_jobs AS (
 UPDATE yt_agent.jobs j SET status='failed',error='One or more render assets failed; inspect asset.error before creating a new revision',updated_at=now()
 WHERE j.status IN('planned','rendering') AND (j.id IN(SELECT job_id FROM timed_out) OR EXISTS(SELECT 1 FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision AND a.status='failed')) RETURNING id
) SELECT 1 AS tick;`,null,[260,80]);
link('Run Render And Review','Expire Uncertain Work');link('Render And Review Hourly','Expire Uncertain Work');
sql('Claim Render Work',`WITH candidate AS (
 SELECT a.id FROM yt_agent.assets a JOIN yt_agent.jobs j ON j.id=a.job_id AND j.revision=a.revision
 WHERE j.status IN('planned','rendering') AND a.status IN('planned','rendering') AND a.source_asset_id IS NULL
 AND (a.status='planned' OR a.render_id IS NOT NULL) AND a.poll_after<=now()
 AND (a.poll_lease_until IS NULL OR a.poll_lease_until<now())
 AND NOT EXISTS(SELECT 1 FROM yt_agent.assets busy WHERE busy.job_id=a.job_id AND busy.id<>a.id AND busy.poll_lease_until>now())
 ORDER BY a.poll_after,a.ordinal FOR UPDATE OF a,j SKIP LOCKED LIMIT 1
) UPDATE yt_agent.assets a SET poll_lease_until=now()+interval '10 minutes',updated_at=now()
 FROM candidate WHERE a.id=candidate.id
 RETURNING a.*,(SELECT config FROM yt_agent.jobs WHERE id=a.job_id) AS config;`,null,[520,0]);
link('Expire Uncertain Work','Claim Render Work');
conditional('Needs Render Submission',"={{ $json.status === 'planned' }}",[760,0]);link('Claim Render Work','Needs Render Submission');
code('Build Original Edit',buildOriginalEdit,[1000,-220],'One canonical MiniMax video with muted generated audio, optional small captions and continuous selected ElevenLabs voice. Every generated component is quoted once before submission. Legacy planned jobs require a new shared-video plan.').onError='continueRegularOutput';link('Needs Render Submission','Build Original Edit',0);
conditional('Edit Passed Preflight','={{ Boolean($json.edit) }}',[1120,-220]);link('Build Original Edit','Edit Passed Preflight');
sql('Record Render Preflight Failure',`WITH changed AS (
 UPDATE yt_agent.assets SET status='failed',error=$2,poll_lease_until=NULL,updated_at=now()
 WHERE id=$1::uuid AND status='planned' RETURNING job_id
) UPDATE yt_agent.jobs j SET status='failed',error=$2,updated_at=now() FROM changed c WHERE j.id=c.job_id RETURNING j.id;`,"={{ [ $('Claim Render Work').first().json.id, String($json.error?.message || $json.error || 'Render preflight failed before paid generation').slice(0,1500) ] }}",[1240,-560]);link('Edit Passed Preflight','Record Render Preflight Failure',1);
code('Prepare Generation Quotes',prepareGenerationQuotes,[1240,-220]);link('Edit Passed Preflight','Prepare Generation Quotes',0);
http('Quote Every Generation Component',"={{ 'https://api.shotstack.io/edit/' + $json.shotstack_stage + '/generate/quote' }}",[1480,-220],{method:'POST',body:'={{ $json.quote_body }}',uncertain:true});link('Prepare Generation Quotes','Quote Every Generation Component');
code('Price All Generation And Render',priceAllGenerationAndRender,[1720,-220]).onError='continueRegularOutput';link('Quote Every Generation Component','Price All Generation And Render');
conditional('All Quotes Are Valid','={{ Number.isFinite($json.reserved_credits) && Boolean($json.generation_quote_breakdown) }}',[1840,-220]);link('Price All Generation And Render','All Quotes Are Valid');link('All Quotes Are Valid','Record Render Preflight Failure',1);
sql('Reserve Render Credits',`WITH locked_asset AS MATERIALIZED (
 SELECT a.id,a.job_id,j.config,j.render_credits_reserved,
 CASE WHEN jsonb_typeof(j.config->'maxRenderCreditsPerJob')='number' THEN (j.config->>'maxRenderCreditsPerJob')::numeric END AS job_cap,
 CASE WHEN jsonb_typeof(j.config->'maxRenderCreditsPerMonth')='number' THEN (j.config->>'maxRenderCreditsPerMonth')::numeric END AS month_cap,
 'generation:'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS budget_period
 FROM yt_agent.assets a JOIN yt_agent.jobs j ON j.id=a.job_id AND j.revision=a.revision
 WHERE a.id=$2::uuid AND a.job_id=$1::uuid AND a.status='planned' AND a.source_asset_id IS NULL
 AND j.status IN('planned','rendering') FOR UPDATE OF a,j
), eligible AS MATERIALIZED (
 SELECT * FROM locked_asset WHERE config->>'mediaGeneration'='minimax_shared_v1'
 AND $3::numeric>0 AND $3::numeric NOT IN('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 AND job_cap>0 AND month_cap>0 AND render_credits_reserved>=0
 AND render_credits_reserved+$3::numeric<=job_cap AND $3::numeric<=month_cap
), monthly_reservation AS (
 INSERT INTO yt_agent.credit_budgets(period,reserved_credits,updated_at)
 SELECT budget_period,$3::numeric,now() FROM eligible
 ON CONFLICT(period) DO UPDATE SET reserved_credits=yt_agent.credit_budgets.reserved_credits+EXCLUDED.reserved_credits,updated_at=now()
 WHERE yt_agent.credit_budgets.reserved_credits>=0
 AND yt_agent.credit_budgets.reserved_credits+EXCLUDED.reserved_credits<=(SELECT month_cap FROM eligible)
 RETURNING period
), reservation AS (
 UPDATE yt_agent.jobs j SET render_credits_reserved=j.render_credits_reserved+$3::numeric,status='rendering',updated_at=now()
 FROM eligible e,monthly_reservation m WHERE j.id=e.job_id AND m.period=e.budget_period
 RETURNING j.id,j.config,m.period AS budget_period
), changed AS (
 UPDATE yt_agent.assets a SET
 status='submitting',render_credits=$3::numeric,render_stage=j.config->>'shotstackStage',
 render_checkpoint=jsonb_build_object('reserved_credits',$3::numeric,'generation_budget_period',j.budget_period,'edit',$4::jsonb,'voice_quote_credits',$5::numeric,'cost_note',$6::text,'generation_quote_breakdown',$7::jsonb),
 error=NULL,updated_at=now()
 FROM reservation j WHERE a.id=$2::uuid AND a.job_id=j.id AND a.status='planned'
 RETURNING a.*
), declined AS (
 UPDATE yt_agent.assets SET status='failed',error='Invalid shared-video budget or generation estimate exceeds the job/month credit allowance; no paid submission sent',poll_lease_until=NULL,updated_at=now()
 WHERE id=$2::uuid AND status='planned' AND EXISTS(SELECT 1 FROM locked_asset) AND NOT EXISTS(SELECT 1 FROM reservation)
 RETURNING *
), failed_job AS (
 UPDATE yt_agent.jobs SET status='failed',error='Render credit reservation was declined',updated_at=now()
 WHERE id=$1::uuid AND EXISTS(SELECT 1 FROM declined) RETURNING id
) SELECT * FROM changed UNION ALL SELECT * FROM declined;`, '={{ [$json.job_id, $json.id, $json.reserved_credits, JSON.stringify($json.edit), $json.voice_credits, $json.cost_note, JSON.stringify($json.generation_quote_breakdown)] }}',[1960,-220]);
link('All Quotes Are Valid','Reserve Render Credits',0);
conditional('Budget Reserved',"={{ $json.status === 'submitting' }}",[2200,-220]);link('Reserve Render Credits','Budget Reserved');
http('Submit Original Render',"={{ 'https://api.shotstack.io/edit/' + $json.render_stage + '/render' }}",[2440,-220],{method:'POST',body:'={{ $json.render_checkpoint.edit }}',uncertain:true});link('Budget Reserved','Submit Original Render',0);
code('Classify Render Submission',submittedOutcome,[2680,-220]);link('Submit Original Render','Classify Render Submission');
sql('Save Render Submission',`WITH changed AS (
 UPDATE yt_agent.assets SET status=$3,render_id=$4,error=$5,poll_after=now()+interval '45 seconds',poll_lease_until=NULL,
 render_checkpoint=render_checkpoint||jsonb_build_object('submitted_at',now(),'poll_deadline',now()+interval '6 hours'),updated_at=now()
 WHERE id=$1::uuid AND job_id=$2::uuid AND status='submitting' RETURNING job_id,status
) UPDATE yt_agent.jobs j SET status=CASE WHEN c.status='uncertain' THEN 'uncertain' ELSE 'rendering' END,error=CASE WHEN c.status='uncertain' THEN $5 ELSE NULL END,updated_at=now()
 FROM changed c WHERE j.id=c.job_id RETURNING j.id,j.status;`,'={{ [$json.id,$json.job_id,$json.status,$json.render_id,$json.error] }}',[2920,-220]);link('Classify Render Submission','Save Render Submission');

http('Poll Existing Render',"={{ 'https://api.shotstack.io/edit/' + $json.render_stage + '/render/' + encodeURIComponent($json.render_id) }}",[1000,160]);link('Needs Render Submission','Poll Existing Render',1);
code('Classify Render Status',classifyRenderStatus,[1240,160]);link('Poll Existing Render','Classify Render Status');
conditional('Render Is Done','={{ $json.done }}',[1480,160]);link('Classify Render Status','Render Is Done');
http('Get Hosted Asset',"={{ 'https://api.shotstack.io/serve/' + $json.render_stage + '/assets/render/' + encodeURIComponent($json.render_id) }}",[1720,120]);link('Render Is Done','Get Hosted Asset',0);
code('Select Hosted Asset',selectHostedAsset,[1960,120]);link('Get Hosted Asset','Select Hosted Asset');
conditional('Hosted Asset Is Ready','={{ $json.hosted_ready }}',[2200,120]);link('Select Hosted Asset','Hosted Asset Is Ready');
http('Probe Rendered Media',"={{ 'https://api.shotstack.io/edit/' + $json.render_stage + '/probe/' + encodeURIComponent($json.media_url) }}",[2440,100]);link('Hosted Asset Is Ready','Probe Rendered Media',0);
code('Validate Rendered Media',validateRenderedMedia,[2680,100]);link('Probe Rendered Media','Validate Rendered Media');
conditional('Media Metadata Is Valid','={{ $json.valid }}',[2920,100]);link('Validate Rendered Media','Media Metadata Is Valid');
http('Download Verified Render','={{ $json.media_url }}',[3160,80],{auth:false,binary:true});link('Media Metadata Is Valid','Download Verified Render',0);
hash('Hash Render Bytes',[3400,80]);link('Download Verified Render','Hash Render Bytes');
code('Restore Render Binary',function(){return [{json:$input.first().json,binary:$('Download Verified Render').first().binary}];},[3520,80]);link('Hash Render Bytes','Restore Render Binary');
code('Inspect Downloaded Media',inspectDownloadedMedia,[3640,80]);link('Restore Render Binary','Inspect Downloaded Media');
conditional('Downloaded Media Is Valid','={{ $json.valid }}',[3880,80]);link('Inspect Downloaded Media','Downloaded Media Is Valid');
sql('Save Ready Asset',`WITH ready AS (
 UPDATE yt_agent.assets SET status='ready',media_url=$2,sha256=$3,bytes=$4::bigint,
 render_checkpoint=render_checkpoint||jsonb_build_object('actual_duration_seconds',$5::numeric),poll_lease_until=NULL,error=NULL,updated_at=now()
 WHERE id=$1::uuid AND status='rendering' AND source_asset_id IS NULL RETURNING *
), shared AS (
 UPDATE yt_agent.assets a SET status='ready',media_url=m.media_url,sha256=m.sha256,bytes=m.bytes,
 render_id=m.render_id,render_stage=m.render_stage,render_checkpoint=jsonb_build_object('source_asset_id',m.id,'actual_duration_seconds',$5::numeric),
 poll_lease_until=NULL,error=NULL,updated_at=now()
 FROM ready m WHERE a.source_asset_id=m.id AND a.job_id=m.job_id AND a.revision=m.revision
 AND a.status='shared_waiting' AND a.format='instagram_reel' AND m.format='youtube_short' AND a.duration_seconds=m.duration_seconds
 RETURNING a.id
) SELECT id,job_id,status FROM ready;`,'={{ [$json.id,$json.media_url,$json.sha256,$json.bytes,$json.actual_duration_seconds] }}',[4120,80]);link('Downloaded Media Is Valid','Save Ready Asset',0);
sql('Save Poll Outcome',`WITH changed AS (
 UPDATE yt_agent.assets SET status=$2,error=$3,poll_after=now()+interval '45 seconds',poll_lease_until=NULL,updated_at=now()
 WHERE id=$1::uuid AND status='rendering' RETURNING job_id,status
) UPDATE yt_agent.jobs j SET status=CASE WHEN c.status='failed' THEN 'failed' ELSE j.status END,error=CASE WHEN c.status='failed' THEN $3 ELSE j.error END,updated_at=now()
 FROM changed c WHERE j.id=c.job_id RETURNING j.id,j.status;`,'={{ [$json.id,$json.status,$json.error || null] }}',[2680,380]);
link('Render Is Done','Save Poll Outcome',1);link('Hosted Asset Is Ready','Save Poll Outcome',1);link('Media Metadata Is Valid','Save Poll Outcome',1);link('Downloaded Media Is Valid','Save Poll Outcome',1);

sql('Claim Complete Review',`WITH candidate AS (
 SELECT j.id FROM yt_agent.jobs j WHERE j.status IN('planned','rendering')
 AND EXISTS(SELECT 1 FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision)
 AND (j.config->>'mediaGeneration' IS DISTINCT FROM 'minimax_shared_v1' OR (
   (SELECT count(*) FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision)=2
   AND (SELECT count(*) FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision AND a.format='youtube_short' AND a.source_asset_id IS NULL)=1
   AND (SELECT count(*) FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision AND a.format='instagram_reel' AND a.source_asset_id IS NOT NULL)=1))
 AND NOT EXISTS(SELECT 1 FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision
   AND (a.status<>'ready' OR a.sha256 IS NULL OR a.bytes IS NULL OR a.media_url IS NULL))
 AND NOT EXISTS(SELECT 1 FROM yt_agent.assets a LEFT JOIN yt_agent.assets m ON m.id=a.source_asset_id
   WHERE a.job_id=j.id AND a.revision=j.revision AND a.source_asset_id IS NOT NULL
   AND (m.id IS NULL OR m.source_asset_id IS NOT NULL OR m.job_id<>a.job_id OR m.revision<>a.revision
     OR m.status<>'ready' OR m.format<>'youtube_short' OR a.format<>'instagram_reel'
     OR m.media_url IS DISTINCT FROM a.media_url OR m.sha256 IS DISTINCT FROM a.sha256 OR m.bytes IS DISTINCT FROM a.bytes))
 ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1
), frozen AS (
 SELECT j.id,jsonb_build_object('job_id',j.id,'revision',j.revision,'publish_after',j.publish_after,'assets',(
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'source_asset_id',a.source_asset_id,'format',a.format,'title',a.title,'caption',a.caption,'target_id',a.target_id,
 'visibility',a.visibility,'made_for_kids',a.made_for_kids,'contains_synthetic_media',a.contains_synthetic_media,
 'media_url',a.media_url,'sha256',a.sha256,'bytes',a.bytes) ORDER BY a.ordinal)
 FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision)) AS manifest,gen_random_uuid()::text AS raw_token
 FROM yt_agent.jobs j JOIN candidate c ON c.id=j.id
), updated AS (
 UPDATE yt_agent.jobs j SET status='notifying',manifest=f.manifest,manifest_hash=encode(digest(f.manifest::text,'sha256'),'hex'),
 approval_token_hash=encode(digest(f.raw_token,'sha256'),'hex'),approval_expires=now()+interval '24 hours',telegram_message_id=NULL,updated_at=now()
 FROM frozen f WHERE j.id=f.id RETURNING j.*
) SELECT u.*,f.raw_token FROM updated u JOIN frozen f ON f.id=u.id;`,null,[520,760]);
link('Expire Uncertain Work','Claim Complete Review');
code('Build Ordered Review Tasks',buildOrderedReviewTasks,[760,760],'Sends one shared video followed by complete escaped metadata for both destinations. Aliases must match their canonical file exactly. No approval token is sent until every media and metadata message succeeds.');link('Claim Complete Review','Build Ordered Review Tasks');
add('Loop Review Tasks','splitInBatches',3,{batchSize:1,options:{}},[1000,760]);link('Build Ordered Review Tasks','Loop Review Tasks');
conditional('Review Task Is Media',"={{ $json.task === 'media' }}",[1240,760]);link('Loop Review Tasks','Review Task Is Media',1);
http('Download Review File','={{ $json.media_url }}',[1480,640],{auth:false,binary:true});link('Review Task Is Media','Download Review File',0);
hash('Hash Review File',[1720,640]);link('Download Review File','Hash Review File');
code('Restore Review Binary',function(){return [{json:$input.first().json,binary:$('Download Review File').item.binary}];},[1840,640]);link('Hash Review File','Restore Review Binary');
code('Verify Review File',verifyReviewBytes,[1960,640]);link('Restore Review Binary','Verify Review File');
conditional('Review Is Image',"={{ $json.format === 'instagram_image' }}",[2200,640]);link('Verify Review File','Review Is Image');
telegram('Send Finished Image','sendPhoto',{chatId:'={{ $json.telegram_chat_id }}',binaryData:true,binaryPropertyName:'media',additionalFields:{caption:"={{ 'Review file: ' + $json.format + ' / ' + $json.id }}"}},[2440,560]);link('Review Is Image','Send Finished Image',0);
telegram('Send Finished Video','sendVideo',{chatId:'={{ $json.telegram_chat_id }}',binaryData:true,binaryPropertyName:'media',additionalFields:{caption:"={{ 'Review file: ' + $json.format + ' / ' + $json.id }}",supports_streaming:true}},[2440,740]);link('Review Is Image','Send Finished Video',1);
sql('Record Media Preview',`WITH verified AS MATERIALIZED (
 SELECT a.* FROM yt_agent.assets a JOIN yt_agent.jobs j ON j.id=a.job_id AND j.revision=a.revision
 WHERE a.id=$1::uuid AND a.job_id=$6::uuid AND a.source_asset_id IS NULL AND a.status='ready' AND j.status='notifying'
 AND $2<>'' AND a.sha256=$3 AND a.media_url=$4 AND a.bytes=$5::bigint
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.manifest->'assets') f WHERE f->>'id'=a.id::text
   AND f->>'sha256'=$3 AND f->>'media_url'=$4 AND (f->>'bytes')::bigint=$5::bigint)
 FOR UPDATE OF a
), previewed AS (
 UPDATE yt_agent.assets a SET preview_state='sent',preview_message_id=$2,updated_at=now()
 FROM verified m WHERE a.id=m.id OR (a.source_asset_id=m.id AND a.job_id=m.job_id AND a.revision=m.revision
   AND a.status='ready' AND a.format='instagram_reel' AND m.format='youtube_short'
   AND a.sha256=m.sha256 AND a.media_url=m.media_url AND a.bytes=m.bytes
   AND EXISTS(SELECT 1 FROM yt_agent.jobs j,jsonb_array_elements(j.manifest->'assets') f
     WHERE j.id=a.job_id AND f->>'id'=a.id::text AND f->>'source_asset_id'=m.id::text
       AND f->>'sha256'=a.sha256 AND f->>'media_url'=a.media_url AND (f->>'bytes')::bigint=a.bytes))
 RETURNING a.id
) SELECT * FROM previewed;`,"={{ [ $('Verify Review File').item.json.id, String($json.message_id || $json.result?.message_id || ''), $('Verify Review File').item.json.sha256, $('Verify Review File').item.json.media_url, $('Verify Review File').item.json.bytes, $('Verify Review File').item.json.job_id ] }}",[2680,640]);link('Send Finished Image','Record Media Preview');link('Send Finished Video','Record Media Preview');
telegram('Send Exact Publishing Metadata','sendMessage',{chatId:'={{ $json.telegram_chat_id }}',text:'={{ $json.text }}',additionalFields:{parse_mode:'HTML',appendAttribution:false,disable_web_page_preview:true}},[1720,960]);link('Review Task Is Media','Send Exact Publishing Metadata',1);
add('Pause Between Review Messages','wait',1.1,{resume:'timeInterval',amount:1,unit:'seconds'},[2920,900],{webhookId:randomUUID()});link('Record Media Preview','Pause Between Review Messages');link('Send Exact Publishing Metadata','Pause Between Review Messages');link('Pause Between Review Messages','Loop Review Tasks');
code('Prepare One Approval Message',function(){return [{json:$('Claim Complete Review').first().json}];},[1120,1180]);link('Loop Review Tasks','Prepare One Approval Message',0);
telegram('Send Final Approval Buttons','sendMessage',{chatId:"={{ $('Claim Complete Review').first().json.telegram_chat_id }}",text:"={{ 'All files and exact publishing metadata for job ' + $('Claim Complete Review').first().json.id + ' (revision ' + $('Claim Complete Review').first().json.revision + ') are above. Review factual accuracy, media, title, captions, account and visibility. Approve all listed assets or reject this package. Buttons expire in 24 hours. Manifest SHA256: ' + $('Claim Complete Review').first().json.manifest_hash }}",replyMarkup:'inlineKeyboard',inlineKeyboard:{rows:[{row:{buttons:[{text:'Approve all listed assets',additionalFields:{callback_data:"={{ 'a:' + $('Claim Complete Review').first().json.raw_token }}"}},{text:'Reject package',additionalFields:{callback_data:"={{ 'r:' + $('Claim Complete Review').first().json.raw_token }}"}}]}}]},additionalFields:{parse_mode:'HTML',appendAttribution:false,disable_web_page_preview:true}},[1240,1180]);link('Prepare One Approval Message','Send Final Approval Buttons');
sql('Activate Stored Approval',`WITH updated AS (
 UPDATE yt_agent.jobs j SET status='awaiting_approval',telegram_message_id=$2,updated_at=now()
 WHERE j.id=$1::uuid AND j.status='notifying' AND j.manifest_hash=$3
 AND j.manifest_hash=encode(digest(j.manifest::text,'sha256'),'hex') AND j.approval_expires>now()
 AND $2<>'' AND NOT EXISTS(SELECT 1 FROM yt_agent.assets a WHERE a.job_id=j.id AND a.revision=j.revision AND a.preview_state<>'sent')
 RETURNING j.id,j.status,j.manifest_hash
), audit AS (
 INSERT INTO yt_agent.audit(job_id,event,detail) SELECT id,'review_sent',jsonb_build_object('manifest_hash',manifest_hash) FROM updated
) SELECT * FROM updated;`,"={{ [ $('Claim Complete Review').first().json.id, String($json.message_id || $json.result?.message_id || ''), $('Claim Complete Review').first().json.manifest_hash ] }}",[1480,1180]);link('Send Final Approval Buttons','Activate Stored Approval');

add('Read Before Activation','stickyNote',1,{content:'## 04 · Shared MiniMax video and review\nRequires workflow 00 schema and fresh minimax_shared_v1 planned jobs from 01.\n\nCredentials: YT-Agent Database, Shotstack (x-api-key), Telegram.\n\nOne MiniMax Hailuo 3 video + selected ElevenLabs narration is reused for YouTube Shorts and Instagram Reels. All shots and voice are quoted once; 25% margin and render cost reserve against job and calendar-month credits atomically before submission. Stage AI generation remains billable.\n\nHourly polling reduces idle executions. One finished file + exact metadata for both platforms precede one approval. No publishing here.\n\nInterrupted submissions retain their reservation; reconcile before retrying. Older submitted render IDs still poll. Older planned jobs require a new plan. Details: docs/n8n-setup.md.',height:460,width:440},[-500,0]);
const workflow={name:'YT-Agent 04 - Render and Telegram Review',nodes,connections,active:false,settings:{executionOrder:'v1',timezone:'Asia/Kolkata',executionTimeout:1800,saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false},pinData:{},tags:[]};
fs.writeFileSync(new URL('../workflows/04-render-and-review.json',import.meta.url),JSON.stringify(workflow,null,2)+'\n');
console.log('Wrote workflow 04 with '+nodes.length+' native nodes.');
