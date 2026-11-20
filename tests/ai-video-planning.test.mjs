import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const workflow=JSON.parse(fs.readFileSync(new URL('../workflows/01-production.json',import.meta.url),'utf8'));
const nodes=Object.fromEntries(workflow.nodes.map(node=>[node.name,node]));
const config=()=>({niche:'Nature education',language:'en',sourceUrls:['https://example.com/nature'],allowedSourceHosts:['example.com'],sourcePermissionConfirmed:true,
 youtubeChannelId:'UC'+'A'.repeat(22),instagramUserId:'12345',instagramApiVersion:'v27.0',telegramChatId:'-100123',approverIds:['42'],formats:['youtube_short','instagram_reel'],reuseVideoAcrossPlatforms:true,
 shortDurationSeconds:30,youtubeVisibility:'public',madeForKids:false,maxJobsPerDay:1,maxScenes:6,
 maxEstimatedTextCostUsd:0.05,textInputUsdPerMillion:0.4,textOutputUsdPerMillion:1.6,maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,
 shotstackStage:'v1',shotstackRegion:'au',shotstackVoice:'George',mediaGeneration:'minimax_shared_v1',videoModel:'minimax-h3-text-to-video',imageModel:'nano-banana-2',
 videoResolution:'768p',videoShotSeconds:10,visualStyle:'Cinematic natural light and realistic movement.',openaiModel:'gpt-4.1-mini',autoSelectTopic:true,manualTopic:'',enableScheduledProduction:false,publishAfter:null});
const execute=(name,input,refs={},source=nodes[name].parameters.jsCode)=>{
 const result=vm.runInNewContext('(function(){'+source+'})()',{
  Buffer,$input:{first:()=>({json:input}),all:()=>[{json:input}]},$:key=>({first:()=>({json:refs[key]})}),$execution:{id:'fixture-1'},
 },{timeout:1000});
 return JSON.parse(JSON.stringify(result));
};
const configure=c=>execute('Production Config',{runMode:'manual'},{},nodes['Production Config'].parameters.jsCode.replace(/const config = \{[\s\S]*?\n\};/,'const config = '+JSON.stringify(c)+';'))[0].json.config;
const prepare=c=>execute('Prepare Planner Request',{job:{id:'job-1',config:c},source:{url:c.sourceUrls[0],title:'Forest',text:'Forests change with the seasons.'},recent_topics:[],recent_metrics:[]})[0].json;
const planned=prepared=>{
 const request=JSON.parse(prepared.body.messages[1].content);
 return {topic:'A changing forest',videos:request.requested_formats.map(f=>({format:f.format,title:'A changing forest',caption:'AI-generated scenes and narration.',
  scenes:f.shot_durations.map(duration=>({narration:f.format==='instagram_image'?'':'Wind moves through the forest.',onscreen_text:'A living forest',visual_prompt:'A bird glides past pine branches as the camera tracks forward.',duration_seconds:duration}))}))};
};
const parse=(prepared,plan)=>execute('Validate Original Content Plan',{choices:[{message:{content:JSON.stringify(plan)}}]},{'Prepare Planner Request':prepared})[0].json;

test('planner requests one moving-video storyboard with exact MiniMax shot coverage for both platforms',()=>{
 const c=configure(config());
 const prepared=prepare(c),request=JSON.parse(prepared.body.messages[1].content);
 assert.match(prepared.body.messages[0].content,/motion|movement/i);
 assert.equal(request.visual_style,c.visualStyle);
 for(const f of request.requested_formats){
  assert.equal(f.shot_durations.reduce((a,b)=>a+b,0),f.duration_seconds);
  assert.ok(f.shot_durations.length<=c.maxScenes);
  assert.ok(f.shot_durations.every(d=>Number.isInteger(d)&&d>=5&&d<=15));
 }
 assert.equal(request.requested_formats.length,1);
 assert.deepEqual(request.requested_formats[0].shot_durations,[10,10,10]);
});

test('invalid model, noninteger duration, zero budget and insufficient scene cap fail before planning',()=>{
 for(const change of [{videoModel:'unverified-model'},{mediaGeneration:'slides'},{shortDurationSeconds:45.5},{videoShotSeconds:4},{maxScenes:2},{maxRenderCreditsPerJob:0},{maxRenderCreditsPerMonth:15},{reuseVideoAcrossPlatforms:false},{maxJobsPerDay:2},{visualStyle:''},{maxEstimatedTextCostUsd:'Infinity'},{textInputUsdPerMillion:'1'},{textOutputUsdPerMillion:null}]){
  assert.throws(()=>configure({...config(),...change}));
 }
 assert.throws(()=>configure({...config(),formats:['instagram_image'],shotstackVoice:''}));
});

test('production owns durations and account targets; valid motion prompts survive the plan',()=>{
 const prepared=prepare(config()),plan=planned(prepared);
 plan.videos[0].target_id='attacker'; plan.videos[0].scenes[0].duration_seconds=9999;
 const parsed=parse(prepared,plan),asset=parsed.assets[0];
 assert.equal(asset.target_id,config().youtubeChannelId);
 assert.equal(asset.scenes[0].duration_seconds,10);
 assert.match(asset.scenes[0].visual_prompt,/camera tracks/);
 assert.equal(asset.scenes.reduce((s,x)=>s+x.duration_seconds,0),30);
 assert.equal(asset.contains_synthetic_media,true);
 assert.equal(parsed.assets.length,2);
 assert.equal(parsed.assets[1].source_format,'youtube_short');
 assert.equal(parsed.assets[1].target_id,config().instagramUserId);
 assert.deepEqual(parsed.assets[1].scenes,asset.scenes);
 assert.equal(parsed.plan.videos.length,1);
});

test('missing shots, blank motion prompts and oversized narration fail before paid generation',()=>{
 const prepared=prepare(config());
 for(const mutate of [p=>p.videos[0].scenes.pop(),p=>p.videos[0].scenes[0].visual_prompt=' ',p=>p.videos[0].scenes[0].narration='word '.repeat(100),p=>p.videos[0].scenes[0].visual_prompt='x'.repeat(1001)]){
  const plan=planned(prepared);mutate(plan);assert.throws(()=>parse(prepared,plan));
 }
});

test('short final remainder is redistributed rather than generating an unsupported tiny shot',()=>{
 const prepared=prepare(configure({...config(),shortDurationSeconds:13,videoShotSeconds:5}));
 const req=JSON.parse(prepared.body.messages[1].content).requested_formats[0];
 assert.deepEqual(req.shot_durations,[7,6]);
 assert.equal(parse(prepared,planned(prepared)).assets[0].duration_seconds,13);
});

test('one text request covers both platforms and enforces finite text spending limits',()=>{
 const short=prepare(config());
 assert.equal(JSON.parse(short.body.messages[1].content).requested_formats.length,1);
 assert.ok(short.estimated_text_cost_usd>0&&short.estimated_text_cost_usd<config().maxEstimatedTextCostUsd);
 assert.throws(()=>prepare({...config(),maxEstimatedTextCostUsd:0.000001}));
 assert.throws(()=>prepare({...config(),maxEstimatedTextCostUsd:'Infinity',textInputUsdPerMillion:'Infinity'}));
 assert.throws(()=>prepare({...config(),textInputUsdPerMillion:Number.MAX_VALUE}));
});
