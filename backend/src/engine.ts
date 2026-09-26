import * as turf from '@turf/turf';

export type LngLat = { lat: number; lng: number };
export type ShipStatus = 'NORMAL'|'REROUTING'|'DISTRESSED'|'STOPPED'|'ARRIVED'|'STRANDED'|'INSUFFICIENT_FUEL'|'OUT_OF_FUEL';
export type Ship = { id:string; name:string; latitude:number; longitude:number; speed:number; heading:number; destination:any; fuel:number; cargo:any; status:ShipStatus; route:LngLat[]; routeIndex:number; weather:any; pendingDirective?:Directive; lastUpdate:number };
export type Zone = { id:string; name:string; polygon:LngLat[]; createdBy:string; createdAt:number };
export type Directive = { id:string; type:'REROUTE'|'WAYPOINT'|'HOLD'; payload:any; status:'PENDING'|'ACCEPTED'|'ESCALATED'; createdAt:number };
export type Alert = { id:string; type:string; severity:'INFO'|'WARNING'|'HIGH'|'CRITICAL'; shipId:string|null; message:string; metadata:any; status:'ACTIVE'|'ACKNOWLEDGED'|'RESOLVED'; createdAt:number };
const km = (a:LngLat,b:LngLat) => turf.distance([a.lng,a.lat],[b.lng,b.lat],{units:'kilometers'});
const point=(x:LngLat)=>turf.point([x.lng,x.lat]);
const id=(p:string)=>`${p}_${crypto.randomUUID().slice(0,8)}`;
const rangeKm=3200, proximityKm=2;

export class WeatherService {
  private cells:any[]=[]; fallback=false; private last=0;
  async refresh(bbox:any) { if (Date.now()-this.last<240000 && this.cells.length) return; this.last=Date.now();
    try { const c={lat:(bbox.minLat+bbox.maxLat)/2,lng:(bbox.minLng+bbox.maxLng)/2}; const r=await fetch(`${process.env.OPEN_METEO_BASE_URL||'https://api.open-meteo.com/v1/forecast'}?latitude=${c.lat}&longitude=${c.lng}&current=wind_gusts_10m,wind_speed_10m&wind_speed_unit=kmh`); const j:any=await r.json(); const gust=j.current?.wind_gusts_10m||0; this.cells=[{...c,gust,wave:0,adverse:gust>=35,risk:Math.min(1,gust/60)}]; this.fallback=false; }
    catch { const phase=Math.sin(Date.now()/600000); this.cells=[{lat:26,lng:56,gust:35+phase*10,wave:2.1,adverse:true,risk:.65}]; this.fallback=true; }
  }
  at(p:LngLat) { return this.cells.reduce((a,c)=>km(p,c)<km(p,a)?c:a,this.cells[0]||{gust:0,wave:0,adverse:false,risk:0}); }
  obstacles() { return this.cells.filter(c=>c.adverse).map(c=>({center:{lat:c.lat,lng:c.lng},radius:35,weather:true,risk:c.risk})); }
  snapshot() { return {fallback:this.fallback,cells:this.cells}; }
}

export class FleetEngine {
  ships:Ship[]; zones:Zone[]=[]; alerts:Alert[]=[]; events:any[]=[]; readonly water:any; readonly bbox:any; weather=new WeatherService();
  constructor(fleet:any) { this.bbox=fleet.bbox;this.water=turf.polygon([fleet.navigablePolygon]); this.ships=fleet.ships.map((s:any)=>({id:s.id,name:s.name,latitude:s.lat,longitude:s.lng,speed:s.speed,heading:s.heading,destination:s.destination,fuel:s.fuel,cargo:s.cargo,status:'NORMAL',route:[],routeIndex:1,weather:{},lastUpdate:Date.now()})); this.ships.forEach(s=>this.route(s)); }
  private pos(s:Ship):LngLat { return {lat:s.latitude,lng:s.longitude}; }
  private alert(type:string,severity:Alert['severity'],shipId:string|null,message:string,metadata={}) { const existing=this.alerts.find(a=>a.type===type&&a.shipId===shipId&&a.status!=='RESOLVED'&&JSON.stringify(a.metadata)===JSON.stringify(metadata)); if(existing)return existing; const a={id:id('alert'),type,severity,shipId,message,metadata,status:'ACTIVE' as const,createdAt:Date.now()};this.alerts.unshift(a);this.events.unshift({type,shipId,at:Date.now(),payload:a});return a; }
  private route(s:Ship) {
    const start=this.pos(s), end={lat:s.destination.lat,lng:s.destination.lng};
    const restricted=this.zones.map(z=>turf.polygon([[...z.polygon.map(p=>[p.lng,p.lat]),[z.polygon[0].lng,z.polygon[0].lat]]]));
    const step=.10, nodes=new Map<string,{p:LngLat;risk:number}>(), key=(i:number,j:number)=>`${i}:${j}`;
    const rows=Math.round((this.bbox.maxLat-this.bbox.minLat)/step),cols=Math.round((this.bbox.maxLng-this.bbox.minLng)/step);
    for(let i=0;i<=rows;i++)for(let j=0;j<=cols;j++){const p={lat:this.bbox.minLat+i*step,lng:this.bbox.minLng+j*step};if(turf.booleanPointInPolygon(point(p),this.water)&&!restricted.some(z=>turf.booleanPointInPolygon(point(p),z))){nodes.set(key(i,j),{p,risk:this.weather.at(p).risk||0});}}
    const nearest=(p:LngLat)=>{let found:string|undefined,best=Infinity;for(const [k,n] of nodes){const d=km(p,n.p);if(d<best){best=d;found=k}}return found};
    const source=nearest(start),target=nearest(end);if(!source||!target){s.status='STRANDED';this.alert('STRANDED','CRITICAL',s.id,`${s.name} has no navigable path to ${s.destination.name}`);return;}
    const open=new Set([source]),from=new Map<string,string>(),g=new Map([[source,0]]),score=new Map([[source,km(nodes.get(source)!.p,nodes.get(target)!.p)]]);let iterations=0;
    while(open.size&&iterations++<12000){let current=[...open].reduce((a,b)=>(score.get(a)??Infinity)<=(score.get(b)??Infinity)?a:b);if(current===target)break;open.delete(current);const [i,j]=current.split(':').map(Number);for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){const next=key(i+di,j+dj),n=nodes.get(next);if(!n)continue;const tentative=(g.get(current)??Infinity)+km(nodes.get(current)!.p,n.p)*(1+n.risk*2.5);if(tentative<(g.get(next)??Infinity)){from.set(next,current);g.set(next,tentative);score.set(next,tentative+km(n.p,nodes.get(target)!.p));open.add(next);}}}
    if(source!==target&&!from.has(target)){s.status='STRANDED';this.alert('STRANDED','CRITICAL',s.id,`${s.name} is boxed in by restricted zones`);return;}
    const grid:LngLat[]=[];let cursor=target;grid.unshift(nodes.get(cursor)!.p);while(from.has(cursor)){cursor=from.get(cursor)!;grid.unshift(nodes.get(cursor)!.p)}
    // The supplied port list includes terminal ports beyond the simplified water polygon.
    // The water grid governs transit; the short final harbour connection is explicit.
    s.route=[start,...grid.filter((p,i)=>i===0||km(p,grid[i-1])>.01),end];s.routeIndex=1;
  }
  addZone(polygon:LngLat[],name:string,createdBy:string) { if(polygon.length<3)throw new Error('A zone requires at least 3 points'); const z={id:id('zone'),name,polygon,createdBy,createdAt:Date.now()};this.zones.push(z); const poly=turf.polygon([[...polygon.map(p=>[p.lng,p.lat]),[polygon[0].lng,polygon[0].lat]]]); this.ships.forEach(s=>{const route=s.route.length>1?s.route:[this.pos(s),{lat:s.destination.lat,lng:s.destination.lng}];const line=turf.lineString(route.map(p=>[p.lng,p.lat])); if(turf.booleanPointInPolygon(point(this.pos(s)),poly))this.alert('GEOFENCE_BREACH','HIGH',s.id,`${s.name} is inside ${name}`); if(turf.booleanIntersects(line,poly)){s.status='REROUTING';this.route(s);this.events.unshift({type:'REROUTE',shipId:s.id,at:Date.now(),payload:{zoneId:z.id}});}});return z; }
  updateZone(zoneId:string,polygon:LngLat[],name:string){const z=this.zones.find(x=>x.id===zoneId);if(!z)throw new Error('Zone not found');z.polygon=polygon;z.name=name;this.ships.forEach(s=>this.route(s));return z;}
  deleteZone(zoneId:string){this.zones=this.zones.filter(z=>z.id!==zoneId);this.ships.forEach(s=>this.route(s));}
  issue(shipId:string,type:Directive['type'],payload:any){const s=this.ship(shipId); const d={id:id('directive'),type,payload,status:'PENDING' as const,createdAt:Date.now()};s.pendingDirective=d;this.events.unshift({type:'DIRECTIVE_CREATED',shipId,at:Date.now(),payload:d});return d;}
  respond(shipId:string,response:'ACCEPT'|'ESCALATE_DISTRESS',payload:any,analysisOverride?:any){const s=this.ship(shipId),d=s.pendingDirective;if(!d)throw new Error('No directive waiting'); if(response==='ACCEPT'){d.status='ACCEPTED';if(d.type==='HOLD')s.status='STOPPED';else {const target=payload.destination||payload.waypoint||d.payload.destination||d.payload.waypoint;if(target)s.destination=target;s.status='REROUTING';this.route(s);}}else {d.status='ESCALATED';s.status='DISTRESSED';const analysis=analysisOverride||distress(payload.message||'');this.alert('DISTRESS',analysis.severity,s.id,`${s.name}: ${analysis.summary}`,analysis);this.events.unshift({type:'DISTRESS',shipId,at:Date.now(),payload:{message:payload.message,analysis}});}s.pendingDirective=undefined;return {ship:s,directive:d};}
  acknowledge(alertId:string){const a=this.alerts.find(x=>x.id===alertId);if(a)a.status='ACKNOWLEDGED';return a;}
  ship(id:string){const s=this.ships.find(x=>x.id===id);if(!s)throw new Error('Ship not found');return s;}
  async tick(dtMs:number,bbox:any){await this.weather.refresh(bbox);const h=dtMs/3600000;for(const s of this.ships){if(['STOPPED','STRANDED','ARRIVED','OUT_OF_FUEL'].includes(s.status))continue;const target=s.route[s.routeIndex]||{lat:s.destination.lat,lng:s.destination.lng};const distance=s.speed*h, here=this.pos(s), d=km(here,target);let next:LngLat;if(d<=distance){next=target;s.routeIndex++;}else{const bearing=turf.bearing([here.lng,here.lat],[target.lng,target.lat]);next={lat:turf.destination([here.lng,here.lat],distance,bearing,{units:'kilometers'}).geometry.coordinates[1],lng:turf.destination([here.lng,here.lat],distance,bearing,{units:'kilometers'}).geometry.coordinates[0]};s.heading=(bearing+360)%360;}s.latitude=next.lat;s.longitude=next.lng;s.weather=this.weather.at(next);s.fuel=Math.max(0,s.fuel-(distance/rangeKm*100)*(s.weather.adverse?1.3:1));if(s.fuel===0){s.status='OUT_OF_FUEL';this.alert('OUT_OF_FUEL','CRITICAL',s.id,`${s.name} is out of fuel`);continue;}const remaining=km(next,{lat:s.destination.lat,lng:s.destination.lng}),available=s.fuel/100*rangeKm;if(available<remaining&&s.status!=='INSUFFICIENT_FUEL'){s.status='INSUFFICIENT_FUEL';this.alert('INSUFFICIENT_FUEL','HIGH',s.id,`${s.name} may not reach ${s.destination.name}`);}if(remaining<.4){s.status='ARRIVED';this.alert('ARRIVAL','INFO',s.id,`${s.name} arrived at ${s.destination.name}`);}for(const z of this.zones){const p=turf.polygon([[...z.polygon.map(x=>[x.lng,x.lat]),[z.polygon[0].lng,z.polygon[0].lat]]]);if(turf.booleanPointInPolygon(point(next),p)){this.alert('GEOFENCE_BREACH','HIGH',s.id,`${s.name} entered ${z.name}`);s.status='REROUTING';this.route(s);}}s.lastUpdate=Date.now();}this.proximity();}
  private proximity(){for(let i=0;i<this.ships.length;i++)for(let j=i+1;j<this.ships.length;j++){const a=this.ships[i],b=this.ships[j],d=km(this.pos(a),this.pos(b)), prior=this.alerts.find(x=>x.type==='PROXIMITY'&&x.metadata.pair===`${a.id}:${b.id}`&&x.status!=='RESOLVED');if(d<proximityKm)this.alert('PROXIMITY','WARNING',a.id,`${a.name} and ${b.name} are ${d.toFixed(2)} km apart`,{pair:`${a.id}:${b.id}`,distance:d});else if(prior&&d>2.25)prior.status='RESOLVED';}}
  snapshot(){return {timestamp:Date.now(),ships:this.ships,zones:this.zones,alerts:this.alerts.slice(0,100),events:this.events.slice(0,100),weatherFallback:this.weather.fallback};}
}
function distress(message:string){const t=message.toLowerCase(), injuries=Number(t.match(/(\d+)\s+(crew|people|injured)/)?.[1]||0), damage=Number(t.match(/(\d+)\s*%/)?.[1]||0);const critical=/fire|sinking|explosion|flood|mayday/.test(t), high=/injur|propulsion|engine|collision|attack/.test(t);return {severity:critical?'CRITICAL':high?'HIGH':'WARNING' as Alert['severity'],issue:critical?'critical emergency':high?'operational failure':'reported concern',injuryCount:injuries,cargoDamagePercent:damage,requiresAssistance:critical||injuries>0,summary:message.slice(0,220),source:'deterministic-local'};}
