import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
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
const Role=z.object({role:z.enum(['COMMAND','CAPTAIN']),shipId:z.string().optional()});
const zone=z.object({name:z.string().min(1).max(80),polygon:z.array(z.object({lat:z.number(),lng:z.number()})).min(3)});
const directive=z.object({shipId:z.string(),type:z.enum(['REROUTE','WAYPOINT','HOLD']),payload:z.record(z.any()).default({})});
const response=z.object({shipId:z.string(),response:z.enum(['ACCEPT','ESCALATE_DISTRESS']),payload:z.record(z.any()).default({})});
type Session={role:'COMMAND'|'CAPTAIN';shipId?:string};
const persist=(type:string, shipId:string|null, payload:any)=>db.event(type,shipId,payload).catch(console.error);
function emit(){io.emit('fleet:state',engine.snapshot());}
function command(s:Session|null){if(s?.role!=='COMMAND')throw new Error('Join a Command session before using this control');}

app.get('/health',(_,r)=>r.json({ok:true,ships:engine.ships.length}));
app.get('/api/config',(_,r)=>r.json({bbox:(fleet as any).bbox,navigablePolygon:(fleet as any).navigablePolygon}));
app.get('/api/history',async(_,r)=>r.json({history:await db.history().catch(()=>[]),events:engine.events}));
io.on('connection',socket=>{let session:Session|null=null;socket.emit('fleet:state',engine.snapshot());
  socket.on('session:join',(raw,reply)=>{try{const parsed=Role.parse(raw);if(parsed.role==='CAPTAIN'&&!engine.ships.some(s=>s.id===parsed.shipId))throw new Error('Invalid captain ship');session=parsed;reply?.({ok:true,session});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:create',async(raw,reply)=>{try{command(session);const p=zone.parse(raw),v=engine.addZone(p.polygon,p.name,'COMMAND');await db.persistZone(v);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));persist('ZONE_CREATED',null,v);io.emit('zone:created',v);emit();reply?.({ok:true,data:v});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:update',async(raw,reply)=>{try{command(session);const p=zone.extend({id:z.string()}).parse(raw),v=engine.updateZone(p.id,p.polygon,p.name);await db.persistZone(v);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));io.emit('zone:updated',v);emit();reply?.({ok:true,data:v});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('zone:delete',async(raw,reply)=>{try{command(session);const id=z.string().parse(raw);engine.deleteZone(id);await db.deleteZone(id);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));io.emit('zone:deleted',id);emit();reply?.({ok:true});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('directive:create',async(raw,reply)=>{try{command(session);const p=directive.parse(raw),d=engine.issue(p.shipId,p.type,p.payload);await db.persistDirective(p.shipId,d);persist('DIRECTIVE_CREATED',p.shipId,d);io.emit('directive:created',{shipId:p.shipId,directive:d});emit();reply?.({ok:true,data:d});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('directive:respond',async(raw,reply)=>{try{const p=response.parse(raw);if(session?.role!=='CAPTAIN'||session?.shipId!==p.shipId)throw new Error('Captain is not authorized for this ship');const analysis=p.response==='ESCALATE_DISTRESS'?await analyzeDistress(String(p.payload.message||'')):undefined;const result=engine.respond(p.shipId,p.response,p.payload,analysis);await db.persistDirective(p.shipId,(result as any).directive);if(analysis)db.distress(p.shipId,String(p.payload.message||''),analysis).catch(console.error);persist('DIRECTIVE_RESPONDED',p.shipId,result);io.emit('directive:responded',{shipId:p.shipId,...result});emit();reply?.({ok:true,data:result});}catch(e:any){reply?.({ok:false,error:e.message});}});
  socket.on('alert:ack',(raw,reply)=>{try{const a=engine.acknowledge(z.string().parse(raw));if(a){db.persistAlert(a).catch(console.error);io.emit('alert:updated',a);emit();}reply?.({ok:true});}catch(e:any){reply?.({ok:false,error:e.message});}});
});
async function start(){await engine.initialize();await db.init();await db.persistFleet(engine.ships);await Promise.all(engine.ships.map(s=>db.persistRoute(s)));http.listen(port,()=>console.log(`HELM backend listening on :${port}`));let lastSnapshot=0,lastWeather=0;setInterval(async()=>{await engine.tick(tickMs,(fleet as any).bbox);db.persistFleet(engine.ships).catch(console.error);for(const a of engine.alerts.filter(a=>a.createdAt>Date.now()-tickMs-100)) {io.emit('alert:created',a);db.persistAlert(a).catch(console.error);}if(Date.now()-lastSnapshot>30000){lastSnapshot=Date.now();db.snapshot(engine.ships).catch(console.error);}if(Date.now()-lastWeather>300000){lastWeather=Date.now();db.weather(engine.weather.snapshot()).catch(console.error);}emit();},tickMs);}
start().catch(e=>{console.error(e);process.exit(1)});
