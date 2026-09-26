import * as turf from '@turf/turf';

export type LngLat = { lat: number; lng: number };
export type ShipStatus = 'NORMAL'|'REROUTING'|'DISTRESSED'|'STOPPED'|'ARRIVED'|'STRANDED'|'INSUFFICIENT_FUEL'|'OUT_OF_FUEL';
export type Ship = { id:string; name:string; latitude:number; longitude:number; speed:number; heading:number; destination:any; fuel:number; fuelCapacityTons:number; cargo:any; status:ShipStatus; route:LngLat[]; routeIndex:number; weather:any; pendingDirective?:Directive; lastUpdate:number };
export type Zone = { id:string; name:string; polygon:LngLat[]; createdBy:string; createdAt:number };
export type Directive = { id:string; type:'REROUTE'|'WAYPOINT'|'HOLD'; payload:any; status:'PENDING'|'ACCEPTED'|'ESCALATED'; createdAt:number };
export type Alert = { id:string; type:string; severity:'INFO'|'WARNING'|'HIGH'|'CRITICAL'; shipId:string|null; message:string; metadata:any; status:'ACTIVE'|'ACKNOWLEDGED'|'RESOLVED'; createdAt:number };
const km = (a:LngLat,b:LngLat) => turf.distance([a.lng,a.lat],[b.lng,b.lat],{units:'kilometers'});
const point=(x:LngLat)=>turf.point([x.lng,x.lat]);
const id=(p:string)=>`${p}_${crypto.randomUUID().slice(0,8)}`;
const rangeKm=3200, proximityKm=2;

class MinHeap {
  private items: { key: string; priority: number }[] = [];
  get size() { return this.items.length; }
  push(key: string, priority: number) {
    const item = { key, priority };
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.items[parent].priority <= priority) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    if (!this.items.length) return undefined;
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1, right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].priority < this.items[left].priority ? right : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

export class WeatherService {
  private cells:any[]=[]; fallback=false; private last=0; private refreshing=false;
  async refresh(bbox:any, ships:Ship[] = []) { if(this.refreshing||(Date.now()-this.last<240000&&this.cells.length))return;this.refreshing=true;this.last=Date.now();
    const locations = (ships.length ? ships.flatMap(s=>[ {lat:s.latitude,lng:s.longitude}, {lat:s.destination.lat,lng:s.destination.lng} ]) : [{lat:(bbox.minLat+bbox.maxLat)/2,lng:(bbox.minLng+bbox.maxLng)/2}])
      .filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng))
      .filter((p,i,all)=>all.findIndex(x=>x.lat.toFixed(2)===p.lat.toFixed(2)&&x.lng.toFixed(2)===p.lng.toFixed(2))===i);
    try {
      const url=new URL(process.env.OPEN_METEO_BASE_URL||'https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude',locations.map(p=>p.lat.toFixed(2)).join(','));
      url.searchParams.set('longitude',locations.map(p=>p.lng.toFixed(2)).join(','));
      url.searchParams.set('current','wind_gusts_10m,wind_speed_10m');
      url.searchParams.set('wind_speed_unit','kmh');
      const response=await fetch(url,{signal:AbortSignal.timeout(8_000)}); if(!response.ok)throw new Error(`Open-Meteo request failed: ${response.status}`);
      const data:any=await response.json(), results=Array.isArray(data)?data:[data];
      this.cells=locations.map((p,i)=>{const current=results[i]?.current||{},gust=Number(current.wind_gusts_10m)||0,wind=Number(current.wind_speed_10m)||0;return {...p,gust,wind,wave:0,adverse:gust>=35,risk:Math.min(1,gust/60)};});
      this.fallback=false;
    }
    catch { const phase=Math.sin(Date.now()/600000); this.cells=locations.map((p,i)=>{const gust=35+phase*10+(i%3)*2;return {...p,gust,wind:gust*.65,wave:2.1,adverse:gust>=35,risk:Math.min(1,gust/60)};}); this.fallback=true; }
    finally { this.refreshing=false; }
  }
  at(p:LngLat) { return this.cells.reduce((a,c)=>km(p,c)<km(p,a)?c:a,this.cells[0]||{gust:0,wave:0,adverse:false,risk:0}); }
  obstacles() { return this.cells.filter(c=>c.adverse).map(c=>({center:{lat:c.lat,lng:c.lng},radius:35,weather:true,risk:c.risk})); }
  snapshot() { return {fallback:this.fallback,cells:this.cells}; }
}

export class FleetEngine {
  ships:Ship[]; zones:Zone[]=[]; alerts:Alert[]=[]; events:any[]=[]; readonly water:any; readonly bbox:any; weather=new WeatherService();
  constructor(fleet:any,options:{deferRoutes?:boolean}={}) { this.bbox=fleet.bbox;this.water=turf.polygon([fleet.navigablePolygon]); this.ships=fleet.ships.map((s:any)=>({id:s.id,name:s.name,latitude:s.lat,longitude:s.lng,speed:s.speed,heading:s.heading,destination:s.destination,fuel:s.fuel,fuelCapacityTons:s.fuelCapacityTons||10_000,cargo:s.cargo,status:'NORMAL',route:[],routeIndex:1,weather:{},lastUpdate:Date.now()})); if(!options.deferRoutes)this.ships.forEach(s=>this.route(s)); }
  async initialize(){await this.weather.refresh(this.bbox,this.ships);this.ships.forEach(s=>this.route(s));}
  private pos(s:Ship):LngLat { return {lat:s.latitude,lng:s.longitude}; }
  private alert(type:string,severity:Alert['severity'],shipId:string|null,message:string,metadata={}) { const existing=this.alerts.find(a=>a.type===type&&a.shipId===shipId&&a.status!=='RESOLVED'&&JSON.stringify(a.metadata)===JSON.stringify(metadata)); if(existing)return existing; const a={id:id('alert'),type,severity,shipId,message,metadata,status:'ACTIVE' as const,createdAt:Date.now()};this.alerts.unshift(a);this.events.unshift({type,shipId,at:Date.now(),payload:a});return a; }
  private safeSegment(a:LngLat,b:LngLat,restricted:any[]) {
    const samples=Math.max(1,Math.ceil(km(a,b)/3));
    for(let i=1;i<samples;i++){
      const fraction=i/samples,p={lat:a.lat+(b.lat-a.lat)*fraction,lng:a.lng+(b.lng-a.lng)*fraction},feature=point(p);
      if(!turf.booleanPointInPolygon(feature,this.water)||restricted.some(zone=>turf.booleanPointInPolygon(feature,zone)))return false;
    }
    return true;
  }
  private route(s:Ship) {
    let start=this.pos(s);
    const end={lat:s.destination.lat,lng:s.destination.lng};
    const restricted=this.zones.map(z=>turf.polygon([[...z.polygon.map(p=>[p.lng,p.lat]),[z.polygon[0].lng,z.polygon[0].lat]]]));
    const step=.10,nodes=new Map<string,{p:LngLat;risk:number}>(),key=(i:number,j:number)=>`${i}:${j}`;
    const rows=Math.round((this.bbox.maxLat-this.bbox.minLat)/step),cols=Math.round((this.bbox.maxLng-this.bbox.minLng)/step);
    for(let i=0;i<=rows;i++)for(let j=0;j<=cols;j++){
      const p={lat:this.bbox.minLat+i*step,lng:this.bbox.minLng+j*step},feature=point(p);
      if(turf.booleanPointInPolygon(feature,this.water)&&!restricted.some(zone=>turf.booleanPointInPolygon(feature,zone)))nodes.set(key(i,j),{p,risk:this.weather.at(p).risk||0});
    }
    const nearest=(p:LngLat)=>{let found:string|undefined,best=Infinity;for(const [k,n] of nodes){const distance=km(p,n.p);if(distance<best){best=distance;found=k;}}return found;};
    const source=nearest(start),target=nearest(end);
    if(!source||!target){s.status='STRANDED';this.alert('STRANDED','CRITICAL',s.id,`${s.name} has no navigable path to ${s.destination.name}`);return;}
    const sourcePoint=nodes.get(source)!.p;
    const startInsideZone=restricted.some(zone=>turf.booleanPointInPolygon(point(start),zone));
    if(!turf.booleanPointInPolygon(point(start),this.water)||(!startInsideZone&&!this.safeSegment(start,sourcePoint,restricted))){
      s.latitude=sourcePoint.lat;s.longitude=sourcePoint.lng;start=sourcePoint;
    }
    const frontier=new MinHeap(),from=new Map<string,string>(),g=new Map<string,number>([[source,0]]),score=new Map<string,number>([[source,km(sourcePoint,nodes.get(target)!.p)]]),closed=new Set<string>();
    frontier.push(source,score.get(source)!);
    const offsets=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];let iterations=0;
    while(frontier.size&&iterations++<100_000){
      const item=frontier.pop()!,current=item.key;
      if(closed.has(current)||item.priority>(score.get(current)??Infinity))continue;
      if(current===target)break;
      closed.add(current);
      const [i,j]=current.split(':').map(Number),currentNode=nodes.get(current)!;
      for(const [di,dj] of offsets){
        const next=key(i+di,j+dj),nextNode=nodes.get(next);
        if(!nextNode||closed.has(next)||!this.safeSegment(currentNode.p,nextNode.p,restricted))continue;
        const segmentKm=km(currentNode.p,nextNode.p),weatherCost=1+(currentNode.risk+nextNode.risk)/2*2.5,tentative=(g.get(current)??Infinity)+segmentKm*weatherCost;
        if(tentative<(g.get(next)??Infinity)){
          from.set(next,current);g.set(next,tentative);const priority=tentative+km(nextNode.p,nodes.get(target)!.p);score.set(next,priority);frontier.push(next,priority);
        }
      }
    }
    if(source!==target&&!from.has(target)){s.status='STRANDED';this.alert('STRANDED','CRITICAL',s.id,`${s.name} is boxed in by land or restricted zones`);return;}
    const grid:LngLat[]=[];let cursor=target;grid.unshift(nodes.get(cursor)!.p);while(from.has(cursor)){cursor=from.get(cursor)!;grid.unshift(nodes.get(cursor)!.p);}
    // End at the nearest navigable approach point; don't animate a ship onto a land port coordinate.
    s.route=[start,...grid.filter(p=>km(p,start)>.01)];s.routeIndex=s.route.length>1?1:0;
    // A newly valid route after editing/removing a zone makes a stranded ship mobile again.
    if(s.status==='STRANDED')s.status='NORMAL';
  }
  addZone(polygon:LngLat[],name:string,createdBy:string) { if(polygon.length<3)throw new Error('A zone requires at least 3 points'); const z={id:id('zone'),name,polygon,createdBy,createdAt:Date.now()};this.zones.push(z); const poly=turf.polygon([[...polygon.map(p=>[p.lng,p.lat]),[polygon[0].lng,polygon[0].lat]]]); this.ships.forEach(s=>{const route=s.route.length>1?s.route:[this.pos(s),{lat:s.destination.lat,lng:s.destination.lng}];const line=turf.lineString(route.map(p=>[p.lng,p.lat])); if(turf.booleanPointInPolygon(point(this.pos(s)),poly))this.alert('GEOFENCE_BREACH','HIGH',s.id,`${s.name} is inside ${name}`); if(turf.booleanIntersects(line,poly)){s.status='REROUTING';this.route(s);this.events.unshift({type:'REROUTE',shipId:s.id,at:Date.now(),payload:{zoneId:z.id}});}});return z; }
  updateZone(zoneId:string,polygon:LngLat[],name:string){const z=this.zones.find(x=>x.id===zoneId);if(!z)throw new Error('Zone not found');z.polygon=polygon;z.name=name;this.ships.forEach(s=>{if(s.status==='STRANDED')s.status='NORMAL';this.route(s);});return z;}
  deleteZone(zoneId:string){this.zones=this.zones.filter(z=>z.id!==zoneId);this.ships.forEach(s=>{if(s.status==='STRANDED')s.status='NORMAL';this.route(s);});}
  issue(shipId:string,type:Directive['type'],payload:any){const s=this.ship(shipId); const d={id:id('directive'),type,payload,status:'PENDING' as const,createdAt:Date.now()};s.pendingDirective=d;this.events.unshift({type:'DIRECTIVE_CREATED',shipId,at:Date.now(),payload:d});return d;}
  respond(shipId:string,response:'ACCEPT'|'ESCALATE_DISTRESS',payload:any,analysisOverride?:any){const s=this.ship(shipId),d=s.pendingDirective;if(!d)throw new Error('No directive waiting'); if(response==='ACCEPT'){d.status='ACCEPTED';if(d.type==='HOLD')s.status='STOPPED';else {const target=payload.destination||payload.waypoint||d.payload.destination||d.payload.waypoint;if(target)s.destination=target;s.status='REROUTING';this.route(s);}}else {d.status='ESCALATED';s.status='DISTRESSED';const analysis=analysisOverride||distress(payload.message||'');this.alert('DISTRESS',analysis.severity,s.id,`${s.name}: ${analysis.summary}`,analysis);this.events.unshift({type:'DISTRESS',shipId,at:Date.now(),payload:{message:payload.message,analysis}});}s.pendingDirective=undefined;return {ship:s,directive:d};}
  acknowledge(alertId:string){const a=this.alerts.find(x=>x.id===alertId);if(a)a.status='ACKNOWLEDGED';return a;}
  ship(id:string){const s=this.ships.find(x=>x.id===id);if(!s)throw new Error('Ship not found');return s;}
  private remainingFuelForRoute(s:Ship,position:LngLat,nextIndex:number){
    let previous=position,required=0;
    for(let i=nextIndex;i<s.route.length;i++){
      const target=s.route[i],distance=km(previous,target),sample={lat:(previous.lat+target.lat)/2,lng:(previous.lng+target.lng)/2},conditions=this.weather.at(sample);
      required+=distance/rangeKm*s.fuelCapacityTons*(conditions.adverse?1.3:1);previous=target;
    }
    return required;
  }
  async tick(dtMs:number,bbox:any){
    void this.weather.refresh(bbox,this.ships);const hours=dtMs/3600000;
    for(const s of this.ships){
      if(['STOPPED','STRANDED','ARRIVED','OUT_OF_FUEL'].includes(s.status))continue;
      if(s.routeIndex>=s.route.length){s.status='ARRIVED';this.alert('ARRIVAL','INFO',s.id,`${s.name} arrived at ${s.destination.name}`);continue;}
      const target=s.route[s.routeIndex],here=this.pos(s),remainingSegmentKm=km(here,target),maxDistanceKm=s.speed*hours;
      let next:LngLat;
      if(remainingSegmentKm<=maxDistanceKm){next=target;s.routeIndex++;}
      else {const bearing=turf.bearing([here.lng,here.lat],[target.lng,target.lat]),coordinates=turf.destination([here.lng,here.lat],maxDistanceKm,bearing,{units:'kilometers'}).geometry.coordinates;next={lat:coordinates[1],lng:coordinates[0]};s.heading=(bearing+360)%360;}
      const movedKm=km(here,next);s.latitude=next.lat;s.longitude=next.lng;s.weather=this.weather.at(next);
      const burnTons=movedKm/rangeKm*s.fuelCapacityTons*(s.weather.adverse?1.3:1);s.fuel=Math.max(0,s.fuel-burnTons);
      if(s.fuel<=0){s.status='OUT_OF_FUEL';this.alert('OUT_OF_FUEL','CRITICAL',s.id,`${s.name} is out of fuel`);continue;}
      const requiredTons=this.remainingFuelForRoute(s,next,s.routeIndex);
      if(s.fuel<requiredTons&&s.status!=='INSUFFICIENT_FUEL'){s.status='INSUFFICIENT_FUEL';this.alert('INSUFFICIENT_FUEL','HIGH',s.id,`${s.name} may not reach ${s.destination.name} with its remaining fuel`);}
      else if(s.fuel>=requiredTons&&s.status==='INSUFFICIENT_FUEL')s.status='NORMAL';
      if(s.routeIndex>=s.route.length){s.status='ARRIVED';this.alert('ARRIVAL','INFO',s.id,`${s.name} arrived at ${s.destination.name}`);}
      for(const zone of this.zones){const polygon=turf.polygon([[...zone.polygon.map(p=>[p.lng,p.lat]),[zone.polygon[0].lng,zone.polygon[0].lat]]]);if(turf.booleanPointInPolygon(point(next),polygon)){this.alert('GEOFENCE_BREACH','HIGH',s.id,`${s.name} entered ${zone.name}`);s.status='REROUTING';this.route(s);}}
      s.lastUpdate=Date.now();
    }
    this.proximity();
  }
  private proximity(){for(let i=0;i<this.ships.length;i++)for(let j=i+1;j<this.ships.length;j++){const a=this.ships[i],b=this.ships[j],d=km(this.pos(a),this.pos(b)), prior=this.alerts.find(x=>x.type==='PROXIMITY'&&x.metadata.pair===`${a.id}:${b.id}`&&x.status!=='RESOLVED');if(d<proximityKm)this.alert('PROXIMITY','WARNING',a.id,`${a.name} and ${b.name} are ${d.toFixed(2)} km apart`,{pair:`${a.id}:${b.id}`,distance:d});else if(prior&&d>2.25)prior.status='RESOLVED';}}
  snapshot(){return {timestamp:Date.now(),ships:this.ships,zones:this.zones,alerts:this.alerts.slice(0,100),events:this.events.slice(0,100),weatherFallback:this.weather.fallback};}
}
function distress(message:string){const t=message.toLowerCase(), injuries=Number(t.match(/(\d+)\s+(crew|people|injured)/)?.[1]||0), damage=Number(t.match(/(\d+)\s*%/)?.[1]||0);const critical=/fire|sinking|explosion|flood|mayday/.test(t), high=/injur|propulsion|engine|collision|attack/.test(t);return {severity:critical?'CRITICAL':high?'HIGH':'WARNING' as Alert['severity'],issue:critical?'critical emergency':high?'operational failure':'reported concern',injuryCount:injuries,cargoDamagePercent:damage,requiresAssistance:critical||injuries>0,summary:message.slice(0,220),source:'deterministic-local'};}
