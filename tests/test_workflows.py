"""Offline standalone n8n graph, safety-contract and JavaScript checks.

No provider, n8n instance, or PostgreSQL connection is used. Real import and
transaction checks remain separate operator setup steps. Node.js is optional.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
FILES = {"00-database-setup.json", "01-production.json", "02-telegram-approval.json",
         "03-publisher.json", "04-render-and-review.json", "05-analytics-feedback.json"}
VERSIONS = {"manualTrigger": {1}, "scheduleTrigger": {1.2}, "code": {2}, "postgres": {2.6},
            "httpRequest": {4.2}, "telegramTrigger": {1.4}, "telegram": {1.2}, "if": {2.2},
            "wait": {1.1}, "crypto": {2}, "splitInBatches": {3}, "stickyNote": {1}, "noOp": {1}}
TRIGGERS = {"manualTrigger", "scheduleTrigger", "telegramTrigger"}

def kind(node):
    return node["type"].removeprefix("n8n-nodes-base.")

def node_map(workflow):
    return {n["name"]: n for n in workflow["nodes"]}

def edges(workflow):
    return {n["name"]: [e["node"] for output in workflow["connections"].get(n["name"], {}).get("main", [])
                        for e in output] for n in workflow["nodes"]}

def reachable(graph, start):
    seen, pending = set(), [start]
    while pending:
        name = pending.pop()
        if name not in seen:
            seen.add(name)
            pending.extend(graph[name])
    return seen

def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)

class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflows = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in (ROOT / "workflows").glob("*.json")}

    def test_six_standalone_exports_inactive_with_unique_ids(self):
        self.assertEqual(set(self.workflows), FILES)
        identifiers = []
        for workflow in self.workflows.values():
            self.assertIs(workflow["active"], False)
            self.assertFalse(workflow.get("pinData"))
            self.assertEqual(workflow["settings"]["executionOrder"], "v1")
            self.assertEqual(workflow["settings"]["saveDataSuccessExecution"], "none")
            self.assertIs(workflow["settings"]["saveManualExecutions"], False)
            self.assertEqual(len(node_map(workflow)), len(workflow["nodes"]))
            for node in workflow["nodes"]:
                self.assertTrue(node["id"])
                identifiers.append(node["id"])
                self.assertIn(node["typeVersion"], VERSIONS[kind(node)])
                self.assertEqual(len(node["position"]), 2)
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_graph_edges_reachability_and_explicit_loop_controls(self):
        for filename, workflow in self.workflows.items():
            with self.subTest(filename=filename):
                nodes, graph = node_map(workflow), edges(workflow)
                for source, outputs in workflow["connections"].items():
                    self.assertIn(source, nodes)
                    self.assertEqual(set(outputs), {"main"})
                    for output in outputs["main"]:
                        for edge in output:
                            self.assertIn(edge["node"], nodes)
                            self.assertEqual(edge["type"], "main")
                            self.assertEqual(edge["index"], 0)
                visited = set()
                for name, node in nodes.items():
                    if kind(node) in TRIGGERS:
                        visited |= reachable(graph, name)
                self.assertEqual(visited, {name for name, node in nodes.items() if kind(node) != "stickyNote"})
                def visit(name, trail):
                    if name in trail:
                        cycle = trail[trail.index(name):]
                        self.assertTrue(any(kind(nodes[x]) in {"splitInBatches", "wait"} for x in cycle), cycle)
                        return
                    for target in graph[name]:
                        visit(target, trail + [name])
                for name, node in nodes.items():
                    if kind(node) in TRIGGERS:
                        visit(name, [])

    def test_no_custom_service_or_embedded_credentials(self):
        text = json.dumps(self.workflows)
        self.assertNotRegex(text, r"http://agent:8000|/publish/tick|/telegram/update|YT-Agent API|/jobs/")
        self.assertNotRegex(text, r"Bearer\s+[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|\d{8,}:[A-Za-z0-9_-]{20,}")
        self.assertNotIn('"n8n-nodes-base.webhook"', text)
        for workflow in self.workflows.values():
            for node in workflow["nodes"]:
                for credential in node.get("credentials", {}).values():
                    self.assertTrue(credential["name"].startswith("YT-Agent "))
                    self.assertTrue(not credential.get("id") or any(marker in credential["id"].upper()
                                    for marker in ("REPLACE", "CONFIGURE")))

    def test_provider_credentials_and_explicit_error_handling(self):
        for workflow in self.workflows.values():
            for node in workflow["nodes"]:
                params = node["parameters"]
                if kind(node) == "httpRequest":
                    if params.get("method", "GET") != "GET":
                        self.assertIn(params.get("authentication"), {"genericCredentialType", "predefinedCredentialType"}, node["name"])
                        self.assertTrue(node.get("credentials"), node["name"])
                        self.assertFalse(node.get("retryOnFail", False), node["name"])
                    for auth, field in (("genericCredentialType", "genericAuthType"), ("predefinedCredentialType", "nodeCredentialType")):
                        if params.get("authentication") == auth:
                            self.assertIn(params[field], node["credentials"])
                    response = params.get("options", {}).get("response", {}).get("response", {})
                    if response.get("neverError"):
                        self.assertIn(node["name"], {"Read Robots Policy", "Read Permitted Page"})
                        child = edges(workflow)[node["name"]][0]
                        self.assertIn("statusCode", node_map(workflow)[child]["parameters"]["jsCode"])
                self.assertFalse(node.get("continueOnFail", False), node["name"])
                if node.get("onError") == "continueErrorOutput":
                    outputs = workflow["connections"].get(node["name"], {}).get("main", [])
                    self.assertGreaterEqual(len(outputs), 2, node["name"])
                    self.assertTrue(outputs[1], node["name"])

    def test_sql_parameters_and_shared_database(self):
        for workflow in self.workflows.values():
            for node in workflow["nodes"]:
                if kind(node) != "postgres":
                    continue
                self.assertEqual(node["credentials"]["postgres"]["name"], "YT-Agent Database")
                query = node["parameters"]["query"]
                self.assertNotIn("{{", query, node["name"])
                if re.search(r"\$[1-9]\d*", query):
                    self.assertRegex(node["parameters"]["options"]["queryReplacement"], r"^=\{\{\s*\[")

    def test_named_references_exist_upstream(self):
        for workflow in self.workflows.values():
            nodes, graph = node_map(workflow), edges(workflow)
            for name, node in nodes.items():
                for text in strings(node["parameters"]):
                    for _, reference in re.findall(r"\$\((['\"])(.*?)\1\)", text):
                        self.assertIn(reference, nodes)
                        self.assertIn(name, reachable(graph, reference), (reference, name))
                    self.assertNotRegex(text, r"\$(?:env|vars|credentials)\b")

    def test_code_nodes_do_not_depend_on_unsupported_host_globals(self):
        for workflow in self.workflows.values():
            for node in workflow["nodes"]:
                if kind(node) == "code":
                    self.assertNotRegex(node["parameters"]["jsCode"],
                                        r"\bnew\s+(?:URL|URLSearchParams)\s*\(|\brequire\s*\(|\bprocess\s*\.",
                                        node["name"])

    def test_production_blocks_paid_calls_and_implicit_scheduling_by_default(self):
        nodes = node_map(self.workflows["01-production.json"])
        self.assertIs(nodes["Daily Production - Opt In"]["disabled"], True)
        source = nodes["Production Config"]["parameters"]["jsCode"]
        for setting in ("enableScheduledProduction: false", "sourcePermissionConfirmed: false", "maxEstimatedTextCostUsd: 0.05", "maxRenderCreditsPerJob: 16", "maxRenderCreditsPerMonth: 500"):
            self.assertIn(setting, source)

    def test_approval_is_one_use_authorized_and_manifest_bound(self):
        nodes = node_map(self.workflows["02-telegram-approval.json"])
        trigger = nodes["Telegram Approval Callback"]
        self.assertEqual(trigger["parameters"]["updates"], ["callback_query"])
        self.assertGreater(trigger["typeVersion"], 1)
        self.assertEqual(trigger["credentials"]["telegramApi"]["name"], "YT-Agent Telegram")
        sql = nodes["Apply Approval Atomically"]["parameters"]["query"]
        for safeguard in ("j.status = 'awaiting_approval'", "j.approval_expires > now()", "j.telegram_chat_id = $3::text",
                          "j.approver_ids @> jsonb_build_array($4::text)", "j.telegram_message_id = $5::text",
                          "digest($1::text, 'sha256')", "digest(j.manifest::text, 'sha256')", "= j.revision",
                          "approval_token_hash = NULL", "INSERT INTO yt_agent.audit", "WHERE d.status = 'approved'",
                          "ON CONFLICT (asset_id) DO NOTHING"):
            self.assertIn(safeguard, sql)
        self.assertEqual(nodes["Answer Approval Callback"]["parameters"]["operation"], "answerQuery")

    def test_analytics_is_bounded_read_only_and_uses_published_ids(self):
        nodes = node_map(self.workflows["05-analytics-feedback.json"])
        query = nodes["Load Published Assets"]["parameters"]["query"]
        self.assertIn("p.status = 'published'", query)
        self.assertIn("LIMIT 20", query)
        self.assertIn("j.config->>'instagramApiVersion'", query)
        for node in nodes.values():
            if kind(node) == "httpRequest":
                self.assertEqual(node["parameters"]["method"], "GET")
        self.assertIn("'metrics'", nodes["Save Metrics Audit"]["parameters"]["query"])

    @unittest.skipUnless(shutil.which("node"), "Node.js needed for optional JavaScript runtime checks")
    def test_javascript_syntax_guards_and_deterministic_expressions(self):
        script = r"""
const assert=require('node:assert/strict');
const vm=require('node:vm');
const flows=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const outputs={};
const lookup=name=>({first:()=>({json:outputs[name]}),item:{json:outputs[name]},all:()=>[{json:outputs[name]}]});
const now={toISO:()=> '2026-11-20T00:00:00.000Z'};
class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-11-20T00:00:00.000Z']));}}
// Match native globals in n8n 2.48.6 JsTaskRunner.getNativeVariables().
// Node's URL, fetch, process and unrestricted require are intentionally absent.
// This checks global availability, not n8n's full prototype/RPC isolation model.
function context(input={}) {
  const sandbox=vm.createContext({
    $input:{first:()=>({json:input}),all:()=>[{json:input}]},$json:input,$:lookup,
    $workflow:{id:'workflow-1'},$execution:{id:'execution-1'},$now:now,Date:FixedDate,
    Buffer,TextEncoder,TextDecoder,TextEncoderStream,TextDecoderStream,FormData,btoa,atob,
    setTimeout,setInterval,setImmediate,clearTimeout,clearInterval,clearImmediate,
    console:{log(){},warn(){},error(){}}
  },{codeGeneration:{strings:false,wasm:false}});
  vm.runInContext('globalThis.global=globalThis',sandbox);
  return sandbox;
}
function host(value){return value===undefined ? undefined : JSON.parse(JSON.stringify(value));}
function execute(source,input={}) {
  return host(new vm.Script('(function(){'+source+'\n})()').runInContext(context(input),{timeout:1000}));
}
const nodes=Object.fromEntries(Object.values(flows).flatMap(w=>w.nodes).map(n=>[n.name,n]));
function run(name,input={}){const r=execute(nodes[name].parameters.jsCode,input);const o=Array.isArray(r)?r[0].json:r.json;outputs[name]=o;return o;}
function expr(v,input={}){const m=/^=\s*\{\{([\s\S]*)\}\}$/.exec(v);assert.ok(m,v);return execute('return ('+m[1]+');',input);}
function inspect(v){if(typeof v==='string'&&/^=\s*\{\{/.test(v)){const m=/^=\s*\{\{([\s\S]*)\}\}$/.exec(v);assert.ok(m,v);new vm.Script('('+m[1]+')');}else if(v&&typeof v==='object')Object.values(v).forEach(inspect);}
for(const w of Object.values(flows))for(const n of w.nodes){if(n.type==='n8n-nodes-base.code')new vm.Script('(async function(){'+n.parameters.jsCode+'\n})',{filename:n.name});inspect(n.parameters);}
assert.equal(execute('return typeof URL;'),'undefined');
assert.equal(execute('return typeof URLSearchParams;'),'undefined');
assert.equal(execute('return typeof fetch;'),'undefined');
assert.throws(()=>execute('return new URL("https://example.test/");'),/URL is not defined/);
assert.throws(()=>execute('return require("node:fs");'),/require is not defined/);
assert.throws(()=>execute('return process.env;'),/process is not defined/);
assert.equal(execute('return Buffer.byteLength("test", "utf8");'),4);
assert.equal(execute('return new TextEncoder().encode("test").length;'),4);
assert.throws(()=>run('Production Config',{runMode:'manual'}),/niche/i);
assert.throws(()=>run('Production Config',{runMode:'scheduled'}),/scheduled/i);
const config={niche:'Orbital science',language:'en',sourceUrls:['https://science.nasa.gov/solar-system/'],allowedSourceHosts:['science.nasa.gov'],sourcePermissionConfirmed:true,youtubeChannelId:'UC'+'A'.repeat(22),instagramUserId:'12345',instagramApiVersion:'v27.0',telegramChatId:'-100123',approverIds:['42'],formats:['youtube_short','instagram_reel'],reuseVideoAcrossPlatforms:true,shortDurationSeconds:30,youtubeVisibility:'private',madeForKids:false,maxJobsPerDay:1,maxScenes:6,maxEstimatedTextCostUsd:1,textInputUsdPerMillion:1,textOutputUsdPerMillion:1,maxRenderCreditsPerJob:16,maxRenderCreditsPerMonth:500,shotstackStage:'stage',shotstackRegion:'au',shotstackVoice:'George',mediaGeneration:'minimax_shared_v1',videoModel:'minimax-h3-text-to-video',imageModel:'nano-banana-2',videoResolution:'768p',videoShotSeconds:10,visualStyle:'Cinematic realistic motion.',openaiModel:'gpt-4.1-mini',autoSelectTopic:true,manualTopic:'',enableScheduledProduction:false,publishAfter:null};
function configured(c){const source=nodes['Production Config'].parameters.jsCode.replace(/const config = \{[\s\S]*?\n\};/,'const config = '+JSON.stringify(c)+';');return execute(source,{runMode:'manual'})[0].json;}
const plannedConfig=configured(config);assert.equal(plannedConfig.idempotency_key,'manual:execution-1');assert.deepEqual(configured(config),plannedConfig);
assert.throws(()=>configured({...config,sourceUrls:['https://127.0.0.1/private'],allowedSourceHosts:['127.0.0.1']}),/public HTTPS DNS hostname|Private/);
assert.throws(()=>configured({...config,sourceUrls:['https://user:secret@science.nasa.gov/solar-system/']}),/no credentials/);
assert.throws(()=>configured({...config,sourceUrls:['https://www.youtube.com/watch?v=test'],allowedSourceHosts:['www.youtube.com']}),/platform HTML/);
assert.throws(()=>configured({...config,maxEstimatedTextCostUsd:0}),/spend/);
const claim={job:{id:'job-1',config},recent_topics:[],recent_metrics:[]};
const expanded=run('Expand Sources',claim);assert.equal(expanded.robots_url,'https://science.nasa.gov/robots.txt');
assert.equal(run('Robots Gate',{statusCode:200,body:'User-agent: *\nAllow: /'}).source_url,config.sourceUrls[0]);
assert.equal(run('Robots Gate',{statusCode:404,body:''}).source_url,config.sourceUrls[0]);
assert.throws(()=>run('Robots Gate',{statusCode:302,body:''}),/unavailable\/redirected\/denied/);
assert.throws(()=>run('Robots Gate',{statusCode:200,body:'User-agent: *\nDisallow: /solar-system/'}),/disallows/);
assert.throws(()=>run('Robots Gate',{statusCode:200,body:'User-agent: *\nAllow: /\nUser-agent: YT-Agent\nDisallow: /solar-system/'}),/disallows/);
assert.throws(()=>run('Robots Gate',{statusCode:200,body:'User-agent: *\nCrawl-delay: 1'}),/crawl-delay/);
assert.equal(run('Robots Gate',{statusCode:200,body:'User-agent: *\nDisallow: /\nAllow: /solar-system/'}).source_url,config.sourceUrls[0]);
assert.throws(()=>run('Expand Sources',{...claim,job:{...claim.job,config:{...config,sourceUrls:['https://127.0.0.1/private']}}}),/public HTTPS DNS hostname/);
assert.throws(()=>run('Expand Sources',{...claim,job:{...claim.job,config:{...config,sourceUrls:['https://user:secret@science.nasa.gov/private']}}}),/no credentials/);
assert.throws(()=>run('Expand Sources',{...claim,job:{...claim.job,config:{...config,sourceUrls:['https://science.nasa.gov/%2e%2e/private']}}}),/unambiguous/);
const prepared=run('Prepare Planner Request',{job:{id:'job-1',config},source:{url:config.sourceUrls[0],title:'Solar system',text:'Earth follows an orbit around the Sun.'},recent_topics:[],recent_metrics:[]});
assert.ok(prepared.estimated_text_cost_usd>0);assert.equal(prepared.body.response_format.type,'json_object');
const video={format:'youtube_short',title:'An orbit',caption:'Original educational content with AI visuals and narration.',target_id:'untrusted-account',scenes:Array.from({length:3},()=>({narration:'Earth moves around the Sun.',onscreen_text:'One orbit',visual_prompt:'The camera moves slowly around Earth as clouds drift across the surface.'}))};
const planResponse={choices:[{message:{content:JSON.stringify({topic:'Earth orbits the Sun',videos:[video]})}}]};
const plan=run('Validate Original Content Plan',planResponse);assert.equal(plan.assets[0].target_id,config.youtubeChannelId);assert.equal(plan.assets[0].contains_synthetic_media,true);
assert.throws(()=>run('Validate Original Content Plan',{choices:[{message:{content:'{}'}}]}),/Invalid plan/);
const update={update_id:25,callback_query:{id:'callback-id',data:'a:12345678-1234-1234-1234-123456789abc',from:{id:42},message:{chat:{id:-100123},message_id:99}},extra:{preserve:true}};
const approval=run('Validate Approval Callback',update);assert.deepEqual(approval.update,update);assert.equal(approval.action,'a');
assert.deepEqual(expr(nodes['Apply Approval Atomically'].parameters.options.queryReplacement,approval),['12345678-1234-1234-1234-123456789abc','a','-100123','42','99','callback-id']);
assert.equal(expr(nodes['Answer Approval Callback'].parameters.queryId),'callback-id');
assert.equal(run('Validate Approval Callback',{...update,callback_query:{...update.callback_query,data:update.callback_query.data.replace('a:','r:')}}).action,'r');
for(const bad of [{message:{text:'approve'}},{callback_query:{...update.callback_query,data:'approve'}},{callback_query:{...update.callback_query,data:"a:';DROP TABLE jobs;--"}},{callback_query:{...update.callback_query,from:{id:9007199254740992}}},{callback_query:{...update.callback_query,message:{message_id:99}}}])assert.throws(()=>run('Validate Approval Callback',bad));
const base={publication_id:'pub-1',job_id:'job-1',topic:'Orbit science',published_url:'https://example.test/post',youtube_channel_id:'UCtest',instagram_user_id:'12345',instagram_api_version:'v27.0'};
run('Prepare Metric Request',{...base,platform:'youtube',external_id:'abcdefghijk'});
const ytResponse={items:[{id:'abcdefghijk',snippet:{channelId:'UCtest'},statistics:{viewCount:'100',likeCount:'3',commentCount:'2'}}]};
const yt=run('Normalize YouTube Metrics',ytResponse);assert.equal(yt.metrics.views,'100');assert.equal(yt.metrics.observed_at,now.toISO());assert.deepEqual(run('Normalize YouTube Metrics',ytResponse),yt);
assert.throws(()=>run('Normalize YouTube Metrics',{items:[{id:'abcdefghijk',snippet:{channelId:'wrong'}}]}),/account/);assert.throws(()=>run('Normalize YouTube Metrics',{items:[]}),/missing/);
const ig=run('Prepare Metric Request',{...base,platform:'instagram',external_id:'987654321'});assert.equal(expr(nodes['Read Instagram Metrics'].parameters.url,ig),'https://graph.instagram.com/v27.0/987654321');
const metrics=run('Normalize Instagram Metrics',{id:'987654321',like_count:5,comments_count:1,permalink:'https://www.instagram.com/p/test/'});assert.equal(metrics.metrics.likes,'5');assert.equal(metrics.metrics.views,null);assert.equal(JSON.parse(expr(nodes['Save Metrics Audit'].parameters.options.queryReplacement,metrics)[1]).platform,'instagram');
assert.throws(()=>run('Normalize Instagram Metrics',{id:'other'}),/does not match/);
assert.throws(()=>run('Prepare Metric Request',{...base,platform:'instagram',external_id:'../me'}),/Invalid/);
assert.throws(()=>run('Prepare Metric Request',{...base,platform:'instagram',external_id:'123',instagram_api_version:'v27.0/../me'}),/Invalid/);
assert.throws(()=>run('Prepare Metric Request',{...base,platform:'other',external_id:'123'}),/Unsupported/);
process.stdout.write('Workflow syntax, approval, and analytics checks passed.');
"""
        result = subprocess.run([shutil.which("node"), "-e", script], input=json.dumps(self.workflows),
                                text=True, capture_output=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checks passed", result.stdout)

if __name__ == "__main__":
    unittest.main()
