import { ApiError, fields, choice } from './security.js';
import type { Mobile } from './mobile.js';
import { digest, randomToken } from './mobile.js';
export interface Monitoring { device_id:string; owner_mobile_id:string; mode:string; starts_at_ms:number|null; session_id:string; revision:number; urgent_consent:number; last_command_id:string; updated_at_ms:number; }
export function monitoringView(row:Monitoring|null,now:number) {
 return row ? {mode:row.mode,starts_at_ms:row.starts_at_ms,session_id:row.session_id,revision:row.revision,urgent_consent:row.urgent_consent,last_command_id:row.last_command_id,updated_at_ms:row.updated_at_ms,state:row.mode==='OFF'?'OFF':(row.starts_at_ms??Infinity)>now?'SCHEDULED':'ACTIVE'} : {mode:'OFF',state:'OFF',starts_at_ms:null,session_id:null,revision:0,urgent_consent:0,last_command_id:null};
}
export async function monitoringRoute(db:D1Database,mobile:Mobile,now:number,body?:Record<string,unknown>) {
 if(!body)return {serverNow:now,pairedAt:mobile.created_at_ms,monitoring:monitoringView(await db.prepare('SELECT * FROM monitoring_settings WHERE device_id=?').bind(mobile.device_id).first<Monitoring>(),now)};
 fields(body,['commandId','expectedRevision','mode','delayMinutes','urgentConsent']);
 if(typeof body.commandId!=='string'||!/^[a-f0-9-]{32,64}$/.test(body.commandId)||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0||Number(body.expectedRevision)>=Number.MAX_SAFE_INTEGER)throw new ApiError(400,'invalid_command');
 const mode=choice(body.mode,['OFF','IMMEDIATE','SCHEDULED']);
 if(mode!=='OFF'&&body.urgentConsent!==true)throw new ApiError(400,'urgent_consent_required');
 const delay=mode==='SCHEDULED'?body.delayMinutes:0;
 if(!Number.isInteger(delay)||Number(delay)<(mode==='SCHEDULED'?1:0)||Number(delay)>10080)throw new ApiError(400,'invalid_delay');
 const hash=await digest(JSON.stringify([body.expectedRevision,mode,delay,mode!=='OFF']));
 await db.prepare(`INSERT INTO monitoring_commands(device_id,command_id,mobile_id,request_hash,expected_revision,mode,starts_at_ms,session_id,urgent_consent,created_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,command_id) DO NOTHING`).bind(mobile.device_id,body.commandId,mobile.mobile_id,hash,body.expectedRevision,mode,mode==='OFF'?null:now+Number(delay)*60000,randomToken(),mode==='OFF'?0:1,now).run();
 const command=await db.prepare('SELECT * FROM monitoring_commands WHERE device_id=? AND command_id=?').bind(mobile.device_id,body.commandId).first<Monitoring & {request_hash:string;mobile_id:string;applied_revision:number|null;created_at_ms:number;command_id:string}>();
 if(!command||command.mobile_id!==mobile.mobile_id||command.request_hash!==hash)throw new ApiError(409,'command_reused');
 if(command.applied_revision===null)throw new ApiError(409,'revision_conflict');
 // Replays return the ORIGINAL accepted time/session, never a newly computed delay.
 return {serverNow:now,pairedAt:mobile.created_at_ms,monitoring:monitoringView({...command,owner_mobile_id:command.mobile_id,revision:command.applied_revision,last_command_id:command.command_id,updated_at_ms:command.created_at_ms},now)};
}
export function eligibleJob(row:Monitoring|null,job:{mobile_id:string;monitoring_session_id?:string|null;monitoring_revision?:number|null;occurred_at_ms?:number|null;created_at_ms:number},now:number):boolean {
 return !!row&&row.owner_mobile_id===job.mobile_id&&row.mode!=='OFF'&&(row.starts_at_ms??Infinity)<=now&&job.monitoring_session_id===row.session_id&&job.monitoring_revision===row.revision&&(job.occurred_at_ms??-1)>=(row.starts_at_ms??Infinity)&&job.created_at_ms>=(row.starts_at_ms??Infinity);
}
