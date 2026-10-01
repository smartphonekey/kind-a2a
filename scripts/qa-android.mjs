// SPDX-License-Identifier: AGPL-3.0-only
/** Run only on a dedicated Android worker, inside qa-runner's bounded process group.
 * Builds debug APKs locally, owns one fresh emulator and runs explicit instrumentation.
 * @module
 * @see qa/README.md
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function instrumentationPassed(output) {
  return /\bOK \([1-9][0-9]* tests?\)/.test(output) && !/FAILURES!!!|INSTRUMENTATION_FAILED|shortMsg=|Process crashed/.test(output);
}
export async function androidTest({ avd, apk, testApk, instrumentation, port = 5554 }) {
  if (!/^[A-Za-z0-9_.-]+$/.test(avd) || !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/.test(instrumentation) || !Number.isInteger(port) || port < 5554 || port > 5682 || port % 2) throw new Error('Invalid Android test configuration');
  if (!process.env.QA_OUTPUT_DIR || !process.env.ANDROID_SDK_ROOT) throw new Error('Run under QA runner with Android SDK configured');
  // Cooperative host-wide reservation; never guess whether a stale lock is safe to remove.
  const lock=join(tmpdir(),`a2a-qa-android-port-${port}.lock`);
  try { await mkdir(lock,{mode:0o700}); } catch { throw new Error('Android port reserved; reconcile worker ownership'); }
  try {
  const sdk=process.env.ANDROID_SDK_ROOT, adb=join(sdk,'platform-tools','adb'), emulator=join(sdk,'emulator','emulator'), serial=`emulator-${port}`;
  const command = (executable,args,{capture=false,allowFailure=false}={}) => new Promise((done,reject)=>{
    const child=spawn(executable,args,{stdio:['ignore',capture?'pipe':'inherit','inherit'],shell:false}); let output='',truncated=false;
    child.stdout?.on('data',chunk=>{ if(Buffer.byteLength(output)+chunk.length>4_194_304)truncated=true;else output+=chunk.toString(); });
    child.on('error',()=>reject(new Error('Android tool unavailable')));
    child.on('close',code=>code===0&&!truncated||allowFailure?done({code,output}):reject(new Error('Android command failed')));
  });
  // Never take over or wipe an operator's running emulator.
  const requireFreeSerial=async()=>{
    const devices=await command(adb,['devices'],{capture:true});
    if(devices.output.split('\n').some(line=>line.startsWith(serial+'\t')))throw new Error('Requested emulator already exists');
  };
  await requireFreeSerial();
  await command(emulator,['-accel-check']);
  await command('./gradlew',['--no-daemon','assembleDebug','assembleDebugAndroidTest']);
  await requireFreeSerial();
  const device=spawn(emulator,['-avd',avd,'-port',String(port),'-no-window','-no-audio','-no-boot-anim','-no-snapshot','-wipe-data','-accel','on','-gpu','swiftshader'],{stdio:'inherit',shell:false});
  let exited=false;device.on('error',()=>{exited=true;});device.on('exit',()=>{exited=true;});
  try {
    const deadline=Date.now()+180_000;
    let ready=false;
    while(Date.now()<deadline&&!exited) {
      const result=await command(adb,['-s',serial,'shell','getprop','sys.boot_completed'],{capture:true,allowFailure:true});
      if(result.code===0&&result.output.trim()==='1'){ready=true;break;}
      await new Promise(done=>setTimeout(done,1000));
    }
    if(!ready||exited)throw new Error('Android emulator did not boot');
    await command(adb,['-s',serial,'install','-r',apk]);
    if(exited)throw new Error('Android emulator exited during install');
    await command(adb,['-s',serial,'install','-r',testApk]);
    if(exited)throw new Error('Android emulator exited during install');
    const result=await command(adb,['-s',serial,'shell','am','instrument','-w',instrumentation],{capture:true});
    await writeFile(join(process.env.QA_OUTPUT_DIR,'instrumentation.txt'),result.output,{mode:0o600,flag:'wx'});
    if(!instrumentationPassed(result.output))throw new Error('Instrumentation failed or ran zero tests');
  } finally {
    // Only our child is signaled; the outer runner also reaps this process group.
    device.kill('SIGTERM');
    await new Promise(done=>{if(exited)return done();const timer=setTimeout(()=>{device.kill('SIGKILL');done();},1000);device.once('exit',()=>{clearTimeout(timer);done();});});
  }
  } finally { await rmdir(lock); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [avd,apk,testApk,instrumentation]=process.argv.slice(2);
  androidTest({avd,apk,testApk,instrumentation}).catch(()=>{console.error('Android QA blocked or failed; inspect private run logs');process.exitCode=1;});
}
