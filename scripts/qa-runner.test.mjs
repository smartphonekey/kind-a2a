// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecipe, executeStep, runQa } from './qa-runner.mjs';
const step = (code, id = 'test') => ({ id, command: [process.execPath, '-e', code], timeoutMs: 1000 });
const recipe = steps => ({ version: 1, id: 'fixture', platform: 'web', timeoutMs: 4000, steps, evidence: [] });
async function workspace(t) { const p = await mkdtemp(join(tmpdir(), 'qa-test-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
async function run(t, config, cwd, options) { const result = await runQa(config, cwd, options); t.after(() => rm(result.output, {recursive:true,force:true})); return result; }
test('strict recipe rejects unknown options, shell strings, traversal, secret env and duplicate steps', () => {
  const valid = recipe([step('')]); assert.equal(validateRecipe(valid), valid);
  for (const invalid of [{...valid,id:undefined},{...valid,steps:[{...step(''),id:undefined}]},{...valid, unexpected: true}, {...valid, steps:[{...step(''), command:'echo bad'}]}, {...valid, evidence:['../secret']}, {...valid, environment:{TOKEN:'secret'}}, {...valid, steps:[step(''),step('')]}]) assert.throws(() => validateRecipe(invalid));
});
test('executes a test, records hashed evidence and private report', async t => {
  const cwd = await workspace(t); const config = recipe([step("require('fs').writeFileSync('result.txt', 'ok')")]); config.evidence=['result.txt'];
  const { report, output } = await run(t, config, cwd); assert.equal(report.status, 'passed'); assert.equal(report.evidence[0].bytes,2); assert.match(report.evidence[0].sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(join(output,'report.json'),'utf8')), report);
});
test('failure stops later work and missing evidence never passes', async t => {
  const cwd=await workspace(t); const {report}=await run(t,recipe([step('process.exit(4)'),step("throw Error('must not run')",'later')]),cwd);
  assert.equal(report.status,'failed'); assert.equal(report.steps[1].status,'skipped');
  const config=recipe([step('')]); config.evidence=['missing.xml']; assert.equal((await run(t,config,cwd)).report.status,'incomplete');
});
test('rejects symlink evidence and does not include its content',async t=>{
  const cwd=await workspace(t); await symlink('/etc/passwd',join(cwd,'evidence')); const config=recipe([step('')]);config.evidence=['evidence'];
  const {report}=await run(t,config,cwd);assert.equal(report.status,'incomplete');assert.equal(report.evidence[0].status,'unavailable');
});
test('bounds logs, does not inherit credentials, and reports missing executable',async t=>{
  const cwd=await workspace(t);process.env.QA_TEST_SECRET='not-in-child';
  const config=recipe([step("if(process.env.QA_TEST_SECRET)process.exit(9)")]);assert.equal((await run(t,config,cwd)).report.status,'passed');delete process.env.QA_TEST_SECRET;
  const bounded=await executeStep(step("process.stdout.write('a'.repeat(5000))"),{cwd,env:{},timeoutMs:1000,logLimit:100}); assert.equal(bounded.log.length,100);assert.equal(bounded.truncated,true);
  const {report}=await run(t,recipe([{id:'missing',command:['/nonexistent/qa-tool'],timeoutMs:1000}]),cwd); assert.equal(report.status,'blocked');
});
test('deadline and cancellation stop process groups',async t=>{
  const cwd=await workspace(t);const slow={...step('setInterval(()=>{},1000)'),timeoutMs:80};
  assert.equal((await run(t,recipe([slow]),cwd)).report.status,'timed_out');
  const controller=new AbortController();setTimeout(()=>controller.abort(),80);
  assert.equal((await run(t,recipe([step('setInterval(()=>{},1000)')]),cwd,{signal:controller.signal})).report.status,'canceled');
  assert.equal((await run(t,recipe([step('')]),cwd,{signal:controller.signal})).report.status,'canceled');
});
test('iOS on Linux is blocked without executing commands', {skip:process.platform!=='linux'},async t=>{
 const cwd=await workspace(t); const config={...recipe([step('process.exit(9)')]),platform:'ios'};
 const {report}=await run(t,config,cwd);assert.equal(report.status,'blocked');assert.equal(report.steps[0].status,'skipped');
});

test('QA profiles use existing Terraform and reporting contracts',async()=>{
 const {qaAgentVariables}=await import('../qa/agent-profile.mjs');
 const id='00000000-0000-4000-8000-000000000001';
 const variables=qaAgentVariables('android',id,id);const config=JSON.parse(variables.agents['qa-android-v1'].configuration);
 assert.match(config.system_prompt,/execution_reporting/);assert.match(config.system_prompt,/report_outcome/);assert.match(config.system_prompt,/input_required/);
 assert.throws(()=>qaAgentVariables('ios',id,id));assert.throws(()=>qaAgentVariables('web','bad',id));
});
test('Android instrumentation cannot pass with zero tests or failure markers',async()=>{
 const {instrumentationPassed}=await import('./qa-android.mjs');
 assert.equal(instrumentationPassed('OK (2 tests)'),true);assert.equal(instrumentationPassed('OK (1 test)'),true);
 for(const output of ['OK (0 tests)','INSTRUMENTATION_FAILED: error','OK (1 test)\nFAILURES!!!','INSTRUMENTATION_RESULT: shortMsg=Process crashed',''])assert.equal(instrumentationPassed(output),false);
});
test('example recipes validate without invoking app tools',async()=>{
 for(const name of ['web','android'])validateRecipe(JSON.parse(await readFile(new URL(`../qa/recipes/${name}.example.json`,import.meta.url),'utf8')));
});
test('Android adapter builds, boots, installs and checks instrumentation in a fake SDK',async t=>{
 const {mkdir}=await import('node:fs/promises');
 const cwd=await workspace(t),sdk=join(cwd,'sdk');await mkdir(join(sdk,'emulator'),{recursive:true});await mkdir(join(sdk,'platform-tools'),{recursive:true});
 const tool=async(path,code)=>writeFile(path,`#!${process.execPath}\n${code}`,{mode:0o700});
 await tool(join(cwd,'gradlew'),"require('fs').writeFileSync('build-ran','yes')");
 await tool(join(sdk,'emulator','emulator'),"if(process.argv.includes('-accel-check'))process.exit(0);setInterval(()=>{},1000)");
 const adapter=new URL('./qa-android.mjs',import.meta.url).pathname;
 const config={...recipe([{id:'android',command:[process.execPath,adapter,'test-avd','app.apk','test.apk','example.test/androidx.test.runner.AndroidJUnitRunner'],timeoutMs:4000}]),platform:'android',environment:{ANDROID_SDK_ROOT:sdk}};
 const adb=code=>tool(join(sdk,'platform-tools','adb'),code);
 await adb("const a=process.argv.slice(2); if(a.includes('getprop'))console.log('1'); if(a.includes('instrument'))console.log('OK (2 tests)');");
 const {report,output}=await run(t,config,cwd);assert.equal(report.status,'passed');assert.equal(await readFile(join(cwd,'build-ran'),'utf8'),'yes');assert.match(await readFile(join(output,'instrumentation.txt'),'utf8'),/OK/);
 await adb("const a=process.argv.slice(2);if(a.includes('getprop'))console.log('1');if(a.includes('instrument'))console.log('FAILURES!!!');");
 assert.equal((await run(t,config,cwd)).report.status,'failed');
 await adb("if(process.argv.includes('devices'))console.log('emulator-5554\\tdevice');");
 assert.equal((await run(t,config,cwd)).report.status,'failed');
});
