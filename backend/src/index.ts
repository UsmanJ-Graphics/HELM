import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from 'socket.io';
import { z } from 'zod';
import sourceFleet from '../../server/fleet.json' with { type: 'json' };
import { Database } from './db.js';
import { FleetEngine } from './engine.js';
import { analyzeDistress } from './ai.js';
import { adaptFleet } from './fleet.js';

const port=Number(process.env.PORT||3001), tickMs=Math.max(250,Number(process.env.SIMULATION_TICK_MS||1000));
const app=express();app.use(cors({origin:process.env.CLIENT_URL?.split(',')||'*'}));app.use(express.json());
const http=createServer(app);const io=new Server(http,{cors:{origin:process.env.CLIENT_URL?.split(',')||'*'}});
const fleet=adaptFleet(sourceFleet), engine=new FleetEngine(fleet,{deferRoutes:true}), db=new Database();
const Role=z.object({role:z.enum(['COMMAND','CAPTAIN']),shipId:z.string().optional(),accessCode:z.string().optional()});
const captainCodes=new Map((process.env.CAPTAIN_ACCESS_CODES||'').split(',').map(entry=>entry.trim()).filter(Boolean).map(entry=>{const i=entry.indexOf('=');return i>0?[entry.slice(0,i).trim(),entry.slice(i+1).trim()] as const:null}).filter((entry):entry is readonly [string,string]=>Boolean(entry)));
const commandCode=process.env.COMMAND_ACCESS_CODE?.trim()||'';
function codeMatches(actual:string|undefined,expected:string){if(!actual)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
const zone=z.object({name:z.string().min(1).max(80),polygon:z.array(z.object({lat:z.number(),lng:z.number()})).min(3)});
const directive=z.object({shipId:z.string(),type:z.enum(['REROUTE','WAYPOINT','HOLD']),payload:z.record(z.any()).default({})});
const response=z.object({shipId:z.string(),response:z.enum(['ACCEPT','ESCALATE_DISTRESS']),payload:z.record(z.any()).default({})});
type Session={role:'COMMAND'|'CAPTAIN';shipId?:string};
const persist=(type:string, shipId:string|null, payload:any)=>db.event(type,shipId,payload).catch(console.error);
function snapshotFor(session:Session|null){const snapshot=engine.snapshot();if(session?.role==='CAPTAIN'){snapshot.ships=snapshot.ships.filter(ship=>ship.id===session.shipId);snapshot.alerts=snapshot.alerts.filter(alert=>!alert.shipId||alert.shipId===session.shipId);snapshot.events=snapshot.events.filter(event=>!event.shipId||event.shipId===session.shipId);}return snapshot;}
function emit(){for(const socket of io.sockets.sockets.values()){const session:Session|null=socket.data.session||null;if(session)socket.emit('fleet:state',snapshotFor(session));}}
function emitScoped(event:string,payload:any,shipId:string|null){for(const socket of io.sockets.sockets.values()){const session:Session|null=socket.data.session||null;if(session&&(session.role==='COMMAND'||!shipId||session.shipId===shipId))socket.emit(event,payload);}}
function command(s:Session|null){if(s?.role!=='COMMAND')throw new Error('Join a Command session before using this control');}

app.get('/health',(_,r)=>r.json({ok:true,ships:engine.ships.length}));
app.get('/api/config',(_,r)=>r.json({bbox:(fleet as any).bbox,navigablePolygon:(fleet as any).navigablePolygon,navigablePolygons:(fleet as any).navigablePolygons,access:{command:Boolean(commandCode),captainShipIds:[...captainCodes.keys()]},vessels:engine.ships.map(({id,name})=>({id,name}))}));
app.get('/api/history',async(req,r)=>{const role=req.query.role==='CAPTAIN'?'CAPTAIN':'COMMAND',shipId=typeof req.query.shipId==='string'?req.query.shipId:undefined,code=req.get('x-access-code')||undefined;if(role==='COMMAND'&&commandCode&&!codeMatches(code,commandCode))return r.status(401).json({error:'Invalid Command access code'});if(role==='CAPTAIN'&&(!shipId||!engine.ships.some(ship=>ship.id===shipId)||(captainCodes.size&&(!captainCodes.has(shipId)||!codeMatches(code,captainCodes.get(shipId)!)))))return r.status(401).json({error:'Invalid Captain assignment or access code'});const history=await db.history().catch(()=>[]),events=engine.events;return r.json({history:role==='CAPTAIN'?history.filter((row:any)=>row.ship_id===shipId):history,events:role==='CAPTAIN'?events.filter(event=>!event.shipId||event.shipId===shipId):events});});
io.on('connection',socket=>{let session:Session|null=null;socket.data.session=null;
  socket.on('session:leave',()=>{session=null;socket.data.session=null;});
  socket.on('session:join',(raw,reply)=>{session=null;socket.data.session=null;try{const parsed=Role.parse(raw);if(parsed.role==='CAPTAIN'){if(!engine.ships.some(s=>s.id===parsed.shipId))throw new Error('Invalid captain ship');if(captainCodes.size&&(!captainCodes.has(parsed.shipId!)||!codeMatches(parsed.accessCode,captainCodes.get(parsed.shipId!)!)))throw new Error('Invalid access code for this ship');}else if(commandCode&&!codeMatches(parsed.accessCode,commandCode))throw new Error('Invalid Command access code');session={role:parsed.role,shipId:parsed.shipId};socket.data.session=session;reply?.({ok:true,session});socket.emit('fleet:state',snapshotFor(session));}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:create',async(raw,reply)=>{try{command(session);const p=zone.parse(raw),v=engine.addZone(p.polygon,p.name,'COMMAND');await db.persistZone(v);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));persist('ZONE_CREATED',null,v);io.emit('zone:created',v);emit();reply?.({ok:true,data:v});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:update',async(raw,reply)=>{try{command(session);const p=zone.extend({id:z.string()}).parse(raw),v=engine.updateZone(p.id,p.polygon,p.name);await db.persistZone(v);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));io.emit('zone:updated',v);emit();reply?.({ok:true,data:v});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:delete',async(raw,reply)=>{try{command(session);const id=z.string().parse(raw);engine.deleteZone(id);await db.deleteZone(id);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));io.emit('zone:deleted',id);emit();reply?.({ok:true});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('directive:create',async(raw,reply)=>{try{command(session);const p=directive.parse(raw),d=engine.issue(p.shipId,p.type,p.payload);await db.persistDirective(p.shipId,d);persist('DIRECTIVE_CREATED',p.shipId,d);emitScoped('directive:created',{shipId:p.shipId,directive:d},p.shipId);emit();reply?.({ok:true,data:d});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('directive:respond',async(raw,reply)=>{try{const p=response.parse(raw);if(session?.role!=='CAPTAIN'||session?.shipId!==p.shipId)throw new Error('Captain is not authorized for this ship');const analysis=p.response==='ESCALATE_DISTRESS'?await analyzeDistress(String(p.payload.message||'')):undefined;const result=engine.respond(p.shipId,p.response,p.payload,analysis);await db.persistDirective(p.shipId,(result as any).directive);if(analysis)db.distress(p.shipId,String(p.payload.message||''),analysis).catch(console.error);persist('DIRECTIVE_RESPONDED',p.shipId,result);emitScoped('directive:responded',{shipId:p.shipId,...result},p.shipId);emit();reply?.({ok:true,data:result});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('alert:ack',(raw,reply)=>{try{const alertId=z.string().parse(raw),existing=engine.alerts.find(item=>item.id===alertId);if(session?.role!=='COMMAND'&&(!existing||session?.role!=='CAPTAIN'||existing.shipId!==session.shipId))throw new Error('You are not authorized to acknowledge this alert');const a=engine.acknowledge(alertId);if(a){db.persistAlert(a).catch(console.error);emitScoped('alert:updated',a,a.shipId);emit();}reply?.({ok:true});}catch(e:any){reply?.({ok:false,error:e.message});}});
});
async function start(){if(!commandCode&&!captainCodes.size)console.warn('Access codes are not configured; Command and Captain role switching is open for local demo use.');await db.init();engine.zones=await db.zones();await engine.initialize();await db.persistFleet(engine.ships);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));http.listen(port,()=>console.log(`HELM backend listening on :${port}`));let lastSnapshot=0,lastWeather=0;setInterval(async()=>{await engine.tick(tickMs,(fleet as any).bbox);db.persistFleet(engine.ships).catch(console.error);for(const a of engine.alerts.filter(a=>a.createdAt>Date.now()-tickMs-100)) {emitScoped('alert:created',a,a.shipId);db.persistAlert(a).catch(console.error);}if(Date.now()-lastSnapshot>30000){lastSnapshot=Date.now();db.snapshot(engine.ships).catch(console.error);}if(Date.now()-lastWeather>300000){lastWeather=Date.now();db.weather(engine.weather.snapshot()).catch(console.error);}emit();},tickMs);}
start().catch(e=>{console.error(e);process.exit(1)});
