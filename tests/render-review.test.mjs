import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const path = new URL('../workflows/04-render-and-review.json', import.meta.url);
const workflow = JSON.parse(fs.readFileSync(path, 'utf8'));
const nodes = Object.fromEntries(workflow.nodes.map(node => [node.name, node]));
const execute = (name, item, references = {}, helpers = {}) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('$input', '$', nodes[name].parameters.jsCode).call({helpers}, {
    first: () => Array.isArray(item)?item[0]:item, all: () => Array.isArray(item)?item:[item],
  }, key => ({first: () => Array.isArray(references[key])?references[key][0]:references[key], item: references[key], itemMatching:index=>references[key][index]}));
};
const fixture = () => ({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', job_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision:1,
  format:'youtube_short', status:'planned', title:'A useful idea', caption:'Original idea. AI-generated narration.', target_id:'channel123',
  source_asset_id:null,visibility:'private', made_for_kids:false, contains_synthetic_media:true, duration_seconds:30,
  scenes:Array.from({length:3},(_,i)=>({duration_seconds:10,narration:'Start with one small action.', onscreen_text:'Start small', visual_prompt:'Camera tracks a person planting a seed in sunlight, shot '+i})),
  config:{mediaGeneration:'minimax_shared_v1',videoModel:'minimax-h3-text-to-video',videoResolution:'768p',reuseVideoAcrossPlatforms:true,videoShotSeconds:10,visualStyle:'Cinematic natural light, detailed motion.',maxScenes:6,maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,shotstackStage:'stage',shotstackRegion:'au',shotstackVoice:'George',language:'en'},
  telegram_chat_id:'123'});

test('missing voice and zero budget fail before quote or render', async () => {
  for (const mutation of [a=>a.config.shotstackVoice='',a=>a.config.maxRenderCreditsPerJob=0,a=>a.config.maxRenderCreditsPerMonth=0,a=>a.config.maxRenderCreditsPerMonth=Infinity,a=>a.config.maxRenderCreditsPerMonth='500']) {
    const asset=fixture(); mutation(asset);
    await assert.rejects(execute('Build Original Edit', {json:asset}));
  }
});

test('video edit uses full-screen AI shots, optional small captions and one selected continuous voice', async () => {
  const [{json:result}] = await execute('Build Original Edit', {json:fixture()});
  assert.equal(result.edit.output.format,'mp4');
  assert.deepEqual(result.edit.output.size,{width:720,height:1280});
  const clips=result.edit.timeline.tracks.flatMap(track=>track.clips);
  assert.ok(clips.some(clip=>clip.asset.type==='rich-text'));
  const videos=clips.filter(clip=>clip.asset.type==='video');
  assert.equal(videos.length,3);
  assert.deepEqual(videos.map(clip=>[clip.start,clip.length]),[[0,10],[10,10],[20,10]]);
  for(const clip of videos){
    assert.equal(clip.asset.model,'minimax-h3-text-to-video');
    assert.match(clip.asset.prompt,/Camera tracks/); assert.match(clip.asset.prompt,/Cinematic natural light/);
    assert.deepEqual(clip.asset.options,{aspectRatio:'9:16',resolution:'768p',enhancePrompt:false});
    assert.equal(clip.asset.volume,0);
    assert.equal('generateAudio' in clip.asset.options,false);
    assert.equal(clip.width,undefined); assert.equal(clip.height,undefined);
  }
  assert.ok(!clips.some(clip=>clip.asset.type==='svg'));
  assert.ok(clips.filter(clip=>clip.asset.type==='rich-text').every(clip=>clip.height<=1280*.14));
  assert.equal(clips.filter(clip=>clip.asset.type==='audio').length,1);
  assert.equal(clips.find(clip=>clip.asset.type==='audio').asset.options.voice,'George');
  assert.equal(clips.find(clip=>clip.asset.type==='audio').length,'auto');
  assert.ok(clips.every(clip=>!clip.asset.src));
  assert.equal(result.quote_requests.length,4);
  assert.deepEqual(result.quote_requests.slice(0,3).map(request=>request.quote_body),videos.map(({asset:{volume,...asset},length})=>({asset,length})));
  assert.equal(result.quote_requests[3].quote_body.length,undefined);
});

test('each visual timeline track has non-overlapping clips', async () => {
  const asset=fixture();asset.duration_seconds=40;asset.scenes.push({duration_seconds:10,narration:'Make a second action visible and useful.',onscreen_text:'Make it visible',visual_prompt:'Camera pans over a garden'});
  const [{json:result}]=await execute('Build Original Edit',{json:asset});
  for(const track of result.edit.timeline.tracks){
    const clips=track.clips.filter(clip=>typeof clip.length==='number').sort((a,b)=>a.start-b.start);
    for(let i=1;i<clips.length;i++)assert.ok(clips[i].start+0.00001>=clips[i-1].start+clips[i-1].length,'same-track clips overlap');
  }
});

test('aliases and independent Reel, image or long-form assets never prepare paid components', async () => {
  for(const change of [{format:'instagram_image'},{format:'youtube_long'},{format:'instagram_reel'},{source_asset_id:'another-master'}]){
    await assert.rejects(execute('Build Original Edit',{json:{...fixture(),...change}}),/canonical/);
  }
});

test('many completed review tasks produce exactly one final approval message', async () => {
  const job={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',raw_token:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
  const output=await execute('Prepare One Approval Message',[{json:{message_id:123}},{json:{message_id:124}},{json:{message_id:125}}],{'Claim Complete Review':{json:job}});
  assert.equal(output.length,1);
  assert.equal(output[0].json.id,job.id);
  assert.equal(output[0].json.raw_token,job.raw_token);
});

const quoted=async(asset=fixture())=>{
  const [built]=await execute('Build Original Edit',{json:asset});
  const requests=await execute('Prepare Generation Quotes',built);
  const responses=requests.map((request,index)=>({json:{credits:index+1,ceiling:false}}));
  const refs={'Build Original Edit':built,'Prepare Generation Quotes':requests};
  return {built,requests,responses,refs};
};

test('all video shots plus voice are quoted, summed and reserved with render cost and 25 percent margin', async()=>{
  const {built,requests,responses,refs}=await quoted();
  assert.equal(requests.length,4);
  assert.ok(requests.every(item=>item.pairedItem.item===0));
  const [{json:priced}]=await execute('Price All Generation And Render',responses,refs);
  assert.equal(priced.voice_credits,4);
  assert.equal(priced.generation_quote_breakdown.video_credits,6);
  assert.equal(priced.generation_quote_breakdown.image_credits,0);
  assert.equal(priced.generation_quote_breakdown.generation_credits,10);
  assert.equal(priced.reserved_credits,(10+30/60)*1.25);
  assert.equal(priced.generation_quote_breakdown.components.length,built.json.quote_requests.length);
});

test('MiniMax accepts exact 5 and 15 second integer shot boundaries',async()=>{
  for(const duration of [5,15]){
    const asset=fixture();asset.duration_seconds=duration*2;asset.scenes=Array.from({length:2},()=>({...asset.scenes[0],duration_seconds:duration}));
    assert.equal((await quoted(asset)).requests[0].json.quote_body.length,duration);
  }
});

test('invalid, missing or ceiling component quotes cannot become a paid render',async()=>{
  for(const quote of [{credits:-1,ceiling:false},{credits:1,ceiling:true},{credits:1},{credits:'1',ceiling:false},{credits:null,ceiling:false},{credits:NaN,ceiling:false},{credits:Infinity,ceiling:false},{ceiling:false},{error:{message:'provider failed'}}]){
    const {responses,refs}=await quoted();responses[1]={json:quote};
    await assert.rejects(execute('Price All Generation And Render',responses,refs),/quote/);
  }
  const {responses,refs}=await quoted();
  await assert.rejects(execute('Price All Generation And Render',responses.slice(1),refs),/Incomplete/);
  await assert.rejects(execute('Price All Generation And Render',[...responses,responses[0]],refs),/Incomplete/);
});

test('quote aggregation follows n8n provenance and rejects duplicate or altered request pairing',async()=>{
  const {responses,requests,refs}=await quoted();
  const reordered=[requests[3],requests[1],requests[2],requests[0]];
  const priced=await execute('Price All Generation And Render',[responses[3],responses[1],responses[2],responses[0]],{...refs,'Prepare Generation Quotes':reordered});
  assert.equal(priced[0].json.voice_credits,4);
  await assert.rejects(execute('Price All Generation And Render',responses,{...refs,'Prepare Generation Quotes':[requests[0],requests[0],requests[2],requests[3]]}),/pairing/);
  const altered=structuredClone(requests);altered[0].json.quote_body.length=4;
  await assert.rejects(execute('Price All Generation And Render',responses,{...refs,'Prepare Generation Quotes':altered}),/pairing/);
});

test('captions can be omitted without removing vertical AI visuals',async()=>{
  const asset=fixture();asset.scenes.forEach(scene=>scene.onscreen_text='');
  const [{json:built}]=await execute('Build Original Edit',{json:asset});
  assert.deepEqual(built.edit.output.size,{width:720,height:1280});
  assert.equal(built.edit.timeline.tracks.length,2);
  assert.ok(built.edit.timeline.tracks[0].clips.every(clip=>clip.asset.options.aspectRatio==='9:16'));
});

test('legacy planned jobs and unbounded AI input fail before any quotes',async()=>{
  for(const mutate of [a=>delete a.config.mediaGeneration,a=>a.config.mediaGeneration='ai_video_v1',a=>delete a.scenes[0].duration_seconds]){
    const asset=fixture();mutate(asset);await assert.rejects(execute('Build Original Edit',{json:asset}),/[Cc]reate a new job/);
  }
  for(const mutate of [a=>a.scenes[0].duration_seconds=4,a=>a.scenes[0].duration_seconds=16,a=>a.scenes[0].duration_seconds=5.5,a=>a.duration_seconds=29,a=>a.scenes[0].visual_prompt='',a=>a.scenes[0].visual_prompt='x'.repeat(1001),a=>a.config.visualStyle='x'.repeat(501),a=>a.config.videoModel='arbitrary-model',a=>a.config.maxScenes=13,a=>a.config.videoResolution='720p',a=>a.config.reuseVideoAcrossPlatforms=false]){
    const asset=fixture();mutate(asset);await assert.rejects(execute('Build Original Edit',{json:asset}));
  }
  const bounded=fixture();bounded.config.maxScenes=12;bounded.duration_seconds=60;bounded.scenes=Array.from({length:12},()=>({...bounded.scenes[0],duration_seconds:5}));
  assert.equal((await execute('Build Original Edit',{json:bounded}))[0].json.quote_requests.length,13);
  bounded.scenes.push({...bounded.scenes[0]});await assert.rejects(execute('Build Original Edit',{json:bounded}),/shot count/);
});

test('quote failure is routed to failed asset and only a complete reservation can submit; existing IDs still poll',()=>{
  const destinations=(name,output=0)=>workflow.connections[name].main[output].map(edge=>edge.node);
  assert.deepEqual(destinations('All Quotes Are Valid',1),['Record Render Preflight Failure']);
  assert.deepEqual(destinations('All Quotes Are Valid'),['Reserve Render Credits']);
  assert.deepEqual(destinations('Budget Reserved'),['Submit Original Render']);
  assert.deepEqual(destinations('Needs Render Submission',1),['Poll Existing Render']);
  assert.equal(nodes['Price All Generation And Render'].onError,'continueRegularOutput');
  assert.match(nodes['Record Render Preflight Failure'].parameters.query,/status='failed'/);
  assert.match(nodes['Claim Complete Review'].parameters.query,/status<>'ready'/);
});

test('serving URL must be fixed Shotstack HTTPS CDN and same render', async () => {
  const asset={...fixture(), render_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',render_stage:'stage'};
  const ref={'Claim Render Work':{json:asset}};
  const attrs={renderId:asset.render_id,status:'ready',filename:asset.render_id+'.mp4',url:'https://evil.test/file.mp4'};
  await assert.rejects(execute('Select Hosted Asset',{json:{data:[{attributes:attrs}]}},ref));
  attrs.url='https://cdn.shotstack.io/au/stage/owner/'+attrs.filename;
  const [{json:result}]=await execute('Select Hosted Asset',{json:{data:[{attributes:attrs}]}},ref);
  assert.equal(result.hosted_ready,true);
});

test('CDN selection and review work inside a VM without global URL', async () => {
  assert.equal(vm.runInNewContext('typeof URL'),'undefined');
  const asset={...fixture(),render_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',render_stage:'stage',sha256:'a'.repeat(64),bytes:1000};
  const media_url='https://cdn.shotstack.io/au/stage/owner/'+asset.render_id+'.mp4';
  const response={data:[{attributes:{renderId:asset.render_id,status:'ready',filename:asset.render_id+'.mp4',url:media_url}}]};
  const executeVM=(name,item,refs={})=>vm.runInNewContext('(async()=>{'+nodes[name].parameters.jsCode+'})()',{
    $input:{first:()=>({json:item}),all:()=>[{json:item}]},
    $:name=>({first:()=>({json:refs[name]}),item:{json:refs[name]}}),
  },{timeout:1000});
  const selected=await executeVM('Select Hosted Asset',response,{'Claim Render Work':asset});
  assert.equal(selected[0].json.media_url,media_url);
  const job={id:asset.job_id,revision:1,telegram_chat_id:'123',manifest:{assets:[{...asset,media_url}]}};
  const tasks=await executeVM('Build Ordered Review Tasks',job);
  assert.equal(tasks[0].json.task,'media');
  for(const bad of ['https://cdn.shotstack.io:443/au/stage/owner/'+asset.render_id+'.mp4','https://user@cdn.shotstack.io/au/stage/owner/'+asset.render_id+'.mp4',media_url+'?x=1',media_url+'#x','https://cdn.shotstack.io.evil.test/au/stage/owner/'+asset.render_id+'.mp4']){
    job.manifest.assets[0].media_url=bad;
    await assert.rejects(executeVM('Build Ordered Review Tasks',job));
  }
});

test('AI edit and complete quote aggregation run with restricted n8n globals and no URL',async()=>{
  const executeVM=(name,items,refs={})=>vm.runInNewContext('(async()=>{'+nodes[name].parameters.jsCode+'})()',{
    $input:{first:()=>items[0],all:()=>items},
    $:name=>({first:()=>refs[name][0],itemMatching:index=>refs[name][index]}),
  },{timeout:1000});
  const built=await executeVM('Build Original Edit',[{json:fixture()}]);
  const requests=await executeVM('Prepare Generation Quotes',built);
  const priced=await executeVM('Price All Generation And Render',requests.map(()=>({json:{credits:1,ceiling:false}})),{'Build Original Edit':built,'Prepare Generation Quotes':requests});
  assert.equal(priced[0].json.reserved_credits,5.625);
  assert.equal(priced[0].json.generation_quote_breakdown.video_credits,3);
});

test('media QC rejects oversized and wrong-codec outputs before download', async () => {
  const context={...fixture(),media_url:'https://cdn.shotstack.io/au/stage/owner/id.mp4'};
  const refs={'Select Hosted Asset':{json:context}};
  const response={success:true,response:{streams:[{codec_type:'video',codec_name:'h264',width:720,height:1280},{codec_type:'audio',codec_name:'aac'}],format:{duration:'30',size:'45000001'}}};
  const [{json:result}]=await execute('Validate Rendered Media',{json:response},refs);
  assert.equal(result.valid,false);
  assert.match(result.error,/45 MB/);
  response.response.format.size='1000'; response.response.streams[0].codec_name='vp9';
  assert.equal((await execute('Validate Rendered Media',{json:response},refs))[0].json.valid,false);
});

test('media QC rejects truncated or overlong videos and enforces the decimal 45 MB boundary',async()=>{
  const refs={'Select Hosted Asset':{json:fixture()}};
  const response={success:true,response:{streams:[{codec_type:'video',codec_name:'h264',width:720,height:1280},{codec_type:'audio',codec_name:'aac'}],format:{duration:'30',size:'45000000'}}};
  assert.equal((await execute('Validate Rendered Media',{json:response},refs))[0].json.valid,true);
  for(const duration of ['3','29.49','30.51','NaN','0']){
    response.response.format.duration=duration;
    const result=(await execute('Validate Rendered Media',{json:response},refs))[0].json;
    assert.equal(result.valid,false);assert.equal(result.status,'failed');assert.match(result.error,/no approval issued/);
  }
  for(const duration of ['29.5','30','30.5']){
    response.response.format.duration=duration;
    assert.equal((await execute('Validate Rendered Media',{json:response},refs))[0].json.valid,true);
  }
  response.response.format.size='45000001';
  assert.equal((await execute('Validate Rendered Media',{json:response},refs))[0].json.valid,false);
});

test('failed AI generation render cannot proceed to media approval',async()=>{
  const asset={...fixture(),render_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
  const [{json:result}]=await execute('Classify Render Status',{json:{response:{id:asset.render_id,status:'failed',error:'MiniMax shot generation failed'}}},{'Claim Render Work':{json:asset}});
  assert.equal(result.done,false);assert.equal(result.status,'failed');assert.match(result.error,/generation failed/);
  assert.equal(workflow.connections['Render Is Done'].main[1][0].node,'Save Poll Outcome');
});

test('review retains exact captions in escaped readable chunks', async () => {
  const asset={...fixture(),sha256:'a'.repeat(64),bytes:1000,media_url:'https://cdn.shotstack.io/au/stage/owner/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4'};
  asset.caption='A < B & C\n'+'x'.repeat(5000);
  const job={id:asset.job_id,revision:1,telegram_chat_id:'123',manifest:{assets:[asset]}};
  const tasks=await execute('Build Ordered Review Tasks',{json:job});
  assert.equal(tasks[0].json.task,'media');
  const metadata=tasks.slice(1).map(item=>item.json.text).join('');
  assert.ok(metadata.includes('A &lt; B &amp; C\n'));
  assert.ok(metadata.includes(asset.sha256));
  assert.ok(tasks.slice(1).every(item=>item.json.text.length<=3900));
});

const sharedReview=()=>{
  const master={...fixture(),sha256:'a'.repeat(64),bytes:1000,media_url:'https://cdn.shotstack.io/au/stage/owner/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4'};
  const alias={...master,id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',source_asset_id:master.id,format:'instagram_reel',target_id:'instagram123',caption:'Exact Instagram caption',visibility:'public'};
  return {id:master.job_id,revision:1,telegram_chat_id:'123',manifest:{assets:[master,alias]}};
};

test('shared video has one preview followed by exact metadata for both platform destinations',async()=>{
  const job=sharedReview();
  // Manifest order does not allow alias metadata to get ahead of its media.
  job.manifest.assets.reverse();
  const tasks=(await execute('Build Ordered Review Tasks',{json:job})).map(item=>item.json);
  assert.deepEqual(tasks.map(task=>task.task),['media','metadata','metadata']);
  assert.equal(tasks[0].source_asset_id,null);
  assert.match(tasks[1].text,/Format: youtube_short[\s\S]*channel123/);
  assert.match(tasks[2].text,/Format: instagram_reel[\s\S]*instagram123[\s\S]*Exact Instagram caption/);
  assert.equal(tasks.filter(task=>task.task==='media').length,1);
});

test('review rejects orphaned aliases and changed hash, URL, bytes or source before sending a file',async()=>{
  for(const change of [{sha256:'b'.repeat(64)},{bytes:1001},{media_url:'https://cdn.shotstack.io/au/stage/owner/dddddddd-dddd-4ddd-8ddd-dddddddddddd.mp4'},{source_asset_id:'missing'},{format:'youtube_short'}]){
    const job=sharedReview();Object.assign(job.manifest.assets[1],change);
    await assert.rejects(execute('Build Ordered Review Tasks',{json:job}),/canonical source/);
  }
});

test('review verifies actual downloaded bytes against the frozen shared master',async()=>{
  const task=sharedReview().manifest.assets[0],binary={media:{}};
  const refs={'Loop Review Tasks':{json:task}};
  const helpers={getBinaryDataBuffer:async()=>Buffer.alloc(1000)};
  assert.equal((await execute('Verify Review File',{json:{sha256:task.sha256},binary},refs,helpers))[0].json.sha256,task.sha256);
  await assert.rejects(execute('Verify Review File',{json:{sha256:'b'.repeat(64)},binary},refs,helpers),/changed/);
  await assert.rejects(execute('Verify Review File',{json:{sha256:task.sha256},binary},refs,{getBinaryDataBuffer:async()=>Buffer.alloc(999)}),/changed/);
});

test('hourly polling and one canonical submission path reduce duplicate cost',()=>{
  assert.deepEqual(nodes['Render And Review Hourly'].parameters.rule.interval,[{field:'minutes',minutesInterval:60}]);
  assert.equal(workflow.nodes.filter(node=>node.name==='Submit Original Render').length,1);
  assert.match(nodes['Claim Render Work'].parameters.query,/a\.source_asset_id IS NULL/);
  assert.match(nodes['Reserve Render Credits'].parameters.query,/a\.source_asset_id IS NULL/);
  assert.match(nodes['Reserve Render Credits'].parameters.query,/ON CONFLICT\(period\) DO UPDATE/);
  assert.match(nodes['Reserve Render Credits'].parameters.query,/Asia\/Kolkata/);
  assert.equal(nodes['Submit Original Render'].retryOnFail,false);
});
