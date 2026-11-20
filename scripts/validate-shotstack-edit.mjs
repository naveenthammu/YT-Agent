// Validates generated examples against the current official OpenAPI document.
// This fetches documentation only; it never contacts a rendering account.
import fs from 'node:fs';
const response=await fetch('https://shotstack.io/docs/api/api.edit.json');
if(!response.ok)throw new Error('Cannot fetch official Shotstack schema');
const api=await response.json();
const workflow=JSON.parse(fs.readFileSync(new URL('../workflows/04-render-and-review.json',import.meta.url),'utf8'));
const source=workflow.nodes.find(node=>node.name==='Build Original Edit').parameters.jsCode;
const run=new Function('$input',source);
function validate(value,schema,path='$'){
 if(schema.$ref){const target=schema.$ref.split('/').slice(1).reduce((o,key)=>o[key],api);return validate(value,target,path);}
 if(schema.oneOf){const outcomes=schema.oneOf.map(choice=>{try{validate(value,choice,path);return true;}catch{return false;}});if(outcomes.filter(Boolean).length!==1)throw new Error(path+': does not match exactly one schema branch');return;}
 if(schema.anyOf){if(!schema.anyOf.some(choice=>{try{validate(value,choice,path);return true;}catch{return false;}}))throw new Error(path+': no allowed schema branch');return;}
 if(schema.allOf)for(const part of schema.allOf)validate(value,part,path);
 if(schema.enum&&!schema.enum.includes(value))throw new Error(path+': invalid enum '+value);
 if(schema.type==='object'){
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error(path+': expected object');
  for(const key of schema.required||[])if(!(key in value))throw new Error(path+': missing '+key);
  for(const [key,item] of Object.entries(value)){if(schema.properties?.[key])validate(item,schema.properties[key],path+'.'+key);else if(schema.additionalProperties===false)throw new Error(path+': unsupported '+key);}
 }
 if(schema.type==='array'){if(!Array.isArray(value))throw new Error(path+': expected array');for(let i=0;i<value.length;i++)validate(value[i],schema.items,path+'['+i+']');}
 if(schema.type==='string'){
  if(typeof value!=='string')throw new Error(path+': expected string');
  if(schema.maxLength!==undefined&&value.length>schema.maxLength)throw new Error(path+': too long');
  if(schema.minLength!==undefined&&value.length<schema.minLength)throw new Error(path+': too short');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new Error(path+': invalid string pattern');
 }
 if(['number','integer'].includes(schema.type)){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value)))throw new Error(path+': invalid number');
  if(schema.minimum!==undefined&&value<schema.minimum)throw new Error(path+': below minimum');
  if(schema.maximum!==undefined&&value>schema.maximum)throw new Error(path+': above maximum');
 }
 if(schema.type==='boolean'&&typeof value!=='boolean')throw new Error(path+': expected boolean');
}
for(const duration of [5,10,15]){
 const asset={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source_asset_id:null,format:'youtube_short',title:'An original idea',duration_seconds:duration*3,
  scenes:Array.from({length:3},(_,index)=>({duration_seconds:duration,onscreen_text:'Start with one clear action',narration:'Start with one clear action.',visual_prompt:'A cinematic tracking shot through a sunlit garden, scene '+index})),
  config:{mediaGeneration:'minimax_shared_v1',videoModel:'minimax-h3-text-to-video',videoResolution:'768p',reuseVideoAcrossPlatforms:true,videoShotSeconds:10,visualStyle:'Cinematic natural light.',maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,maxScenes:6,shotstackStage:'stage',shotstackRegion:'au',shotstackVoice:'George',language:'en'}};
 const [{json:{edit,quote_requests}}]=run({first:()=>({json:asset})});
 validate(edit,api.components.schemas.Edit);
 for(const request of quote_requests)validate(request.quote_body,api.paths['/generate/quote'].post.requestBody.content['application/json'].schema);
}
console.log('PASS: canonical MiniMax shared-video edits at 5/10/15 second shot lengths and every video/voice quote match current official Shotstack OpenAPI fields, types, bounds and variants. No render or generation calls.');
