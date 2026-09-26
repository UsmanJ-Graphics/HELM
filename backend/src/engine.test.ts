import { describe,it,expect } from 'vitest';
import sourceFleet from '../../server/fleet.json' with { type:'json' };
import { adaptFleet } from './fleet.js';
import { FleetEngine } from './engine.js';
const fleet=adaptFleet(sourceFleet);
describe('fleet engine',()=>{
 it('loads exactly 15 ships',()=>expect(new FleetEngine(fleet).ships).toHaveLength(15));
 it('creates a geofence breach for a ship captured by a new zone',()=>{const e=new FleetEngine(fleet);const s=e.ships[0];e.addZone([{lat:s.latitude-.1,lng:s.longitude-.1},{lat:s.latitude+.1,lng:s.longitude-.1},{lat:s.latitude+.1,lng:s.longitude+.1},{lat:s.latitude-.1,lng:s.longitude+.1}],'Test','COMMAND');expect(e.alerts.some(a=>a.type==='GEOFENCE_BREACH')).toBe(true)});
 it('enforces captain directive acceptance state',()=>{const e=new FleetEngine(fleet);e.issue('MV-1','HOLD',{});e.respond('MV-1','ACCEPT',{});expect(e.ship('MV-1').status).toBe('STOPPED')});
 it('raises one proximity alert for ships within two kilometres',()=>{const e=new FleetEngine(fleet);const a=e.ships[0],b=e.ships[1];b.latitude=a.latitude+.005;b.longitude=a.longitude; (e as any).proximity();expect(e.alerts.filter(x=>x.type==='PROXIMITY')).toHaveLength(1)});
 it('applies the thirty percent adverse-weather fuel penalty in tons',async()=>{const e=new FleetEngine(fleet),s=e.ships[0];s.status='NORMAL';s.route=[{lat:s.latitude,lng:s.longitude},{lat:s.latitude,lng:s.longitude+1}];s.routeIndex=1;s.fuel=s.fuelCapacityTons;(e.weather as any).refresh=async()=>{};(e.weather as any).cells=[{lat:s.latitude,lng:s.longitude,gust:45,wave:2.5,adverse:true,risk:1}];await e.tick(3600000,(fleet as any).bbox);expect(s.fuel).toBeCloseTo(s.fuelCapacityTons-(s.speed/3200*s.fuelCapacityTons*1.3),5)});
 it('marks a vessel as insufficient fuel while it continues moving',async()=>{const e=new FleetEngine(fleet),s=e.ships[0];s.status='NORMAL';s.fuel=1;s.route=[{lat:s.latitude,lng:s.longitude},{lat:s.latitude,lng:s.longitude+1}];s.routeIndex=1;(e.weather as any).refresh=async()=>{};(e.weather as any).cells=[{lat:s.latitude,lng:s.longitude,gust:0,wave:0,adverse:false,risk:0}];await e.tick(1000,(fleet as any).bbox);expect(s.status).toBe('INSUFFICIENT_FUEL');expect(e.alerts.some(x=>x.type==='INSUFFICIENT_FUEL')).toBe(true)});
});
