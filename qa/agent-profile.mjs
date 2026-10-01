// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function qaAgentVariables(platform, organizationId, environmentId) {
  if (!['web','android'].includes(platform) || ![organizationId,environmentId].every(value=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))) throw new Error('Provide platform, organization UUID and reviewed environment UUID');
  const instructions=readFileSync(new URL('./agent-instructions.txt',import.meta.url),'utf8').trim();
  return {organization_id:organizationId,agents:{[`qa-${platform}-v1`]:{
    name:`QA ${platform}`,nickname:`qa-${platform}`,environment_id:environmentId,
    description:`QA ${platform} with approved local test recipes`,
    configuration:JSON.stringify({system_prompt:instructions})
  }}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==5)throw new Error();console.log(JSON.stringify(qaAgentVariables(...process.argv.slice(2)),null,2));}
 catch{console.error('Usage: node qa/agent-profile.mjs <web|android> <organization-uuid> <environment-uuid>');process.exitCode=2;}
}
