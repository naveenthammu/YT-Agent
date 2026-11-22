// Cross-workflow contract: real exported planner -> renderer -> quote aggregation.
// No external requests; provider responses are deterministic fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const load=file=>JSON.parse(fs.readFileSync(new URL('../workflows/'+file,import.meta.url),'utf8'));
const nodes=Object.fromEntries([load('01-production.json'),load('04-render-and-review.json')].flatMap(w=>w.nodes).map(n=>[n.name,n]));
const run=(name,items,refs={})=>JSON.parse(JSON.stringify(vm.runInNewContext('(function(){'+nodes[name].parameters.jsCode+'})()',{
 Buffer,$input:{first:()=>items[0],all:()=>items},$:key=>({first:()=>refs[key][0],all:()=>refs[key],itemMatching:i=>refs[key][i]}),
},{timeout:1000})));

test('one exported storyboard creates one MiniMax render and an Instagram destination reusing its file',()=>{
 const config={formats:['youtube_short','instagram_reel'],reuseVideoAcrossPlatforms:true,niche:'Nature',language:'en',
  shortDurationSeconds:30,maxScenes:6,videoShotSeconds:10,visualStyle:'Natural light and realistic movement.',
  maxEstimatedTextCostUsd:0.05,textInputUsdPerMillion:0.4,textOutputUsdPerMillion:1.6,maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,
  autoSelectTopic:true,mediaGeneration:'minimax_shared_v1',videoModel:'minimax-h3-text-to-video',imageModel:'nano-banana-2',videoResolution:'768p',
  shotstackStage:'stage',shotstackRegion:'au',shotstackVoice:'George',youtubeChannelId:'UC'+'A'.repeat(22),instagramUserId:'123',youtubeVisibility:'private',madeForKids:false};
 const prepare=run('Prepare Planner Request',[{json:{job:{id:'job-1',config},source:{url:'https://example.com/nature',title:'Nature',text:'Leaves move in the wind.'},recent_topics:[],recent_metrics:[]}}]);
 const requested=JSON.parse(prepare[0].json.body.messages[1].content).requested_formats;
 const modelPlan={topic:'A forest in motion',videos:requested.map(f=>({format:f.format,title:'A forest in motion',caption:'AI-generated illustrative visuals and narration.',scenes:f.shot_durations.map((d,i)=>({visual_prompt:'A tracking camera follows a bird moving through sunlit trees, shot '+(i+1),onscreen_text:'',narration:f.format==='instagram_image'?'':'A bird moves among the trees.'}))}))};
 const parsed=run('Validate Original Content Plan',[{json:{choices:[{message:{content:JSON.stringify(modelPlan)}}]}}],{'Prepare Planner Request':prepare})[0].json;
 assert.equal(requested.length,1);
 assert.equal(parsed.assets.length,2);
 assert.equal(parsed.plan.videos.length,1);
 assert.equal(parsed.assets[1].source_format,parsed.assets[0].format);
 assert.deepEqual(parsed.assets[1].scenes,parsed.assets[0].scenes);
 const asset=parsed.assets[0];
  const built=run('Build Original Edit',[{json:{...asset,id:'asset-0',job_id:'job-1',source_asset_id:null,config}}]);
  const clips=built[0].json.edit.timeline.tracks.flatMap(t=>t.clips),visuals=clips.filter(c=>c.asset.type==='video');
  assert.equal(visuals.length,asset.scenes.length);
  assert.equal(visuals.reduce((n,c)=>n+c.length,0),asset.duration_seconds);
  assert.ok(visuals.every(c=>c.asset.prompt.includes('tracking camera')&&!c.asset.src));
  assert.ok(clips.every(c=>c.asset.type!=='svg'));
  assert.ok(visuals.every(c=>c.asset.model==='minimax-h3-text-to-video'&&c.asset.volume===0&&!('generateAudio' in c.asset.options)));
  const quoteRequests=run('Prepare Generation Quotes',built);
  assert.equal(quoteRequests.length,asset.scenes.length+1);
  const quotes=quoteRequests.map(request=>({json:{credits:request.json.kind==='voice'?0.1:2,ceiling:false}}));
  const priced=run('Price All Generation And Render',quotes,{'Build Original Edit':built,'Prepare Generation Quotes':quoteRequests})[0].json;
  assert.equal(priced.generation_quote_breakdown.components.length,quotes.length);
  assert.equal(priced.generation_quote_breakdown.generation_credits,asset.scenes.length*2+0.1);
  assert.ok(priced.reserved_credits>priced.generation_quote_breakdown.generation_credits);
  assert.throws(()=>run('Build Original Edit',[{json:{...parsed.assets[1],id:'asset-1',job_id:'job-1',source_asset_id:'asset-0',config}}]));
});
