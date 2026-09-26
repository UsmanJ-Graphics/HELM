import { z } from 'zod';

const DistressAnalysis = z.object({
  severity: z.enum(['INFO','WARNING','HIGH','CRITICAL']),
  issue: z.string().min(1).max(120),
  injuryCount: z.number().int().min(0).max(1000),
  cargoDamagePercent: z.number().min(0).max(100).nullable(),
  requiresAssistance: z.boolean(),
  summary: z.string().min(1).max(240),
  source: z.string(),
});

function fallback(message:string) {
  const text=message.toLowerCase(),injuryCount=Number(text.match(/(\d+)\s+(crew|people|injured)/)?.[1]||0),damage=Number(text.match(/(\d+)\s*%/)?.[1]||0);
  const critical=/fire|sinking|explosion|flood|mayday/.test(text),high=/injur|propulsion|engine|collision|attack/.test(text);
  return {severity:critical?'CRITICAL':high?'HIGH':'WARNING',issue:critical?'critical emergency':high?'operational failure':'reported concern',injuryCount,cargoDamagePercent:damage||null,requiresAssistance:critical||injuryCount>0,summary:message.slice(0,240)||'Captain escalated a distress event',source:'deterministic-local'};
}

export async function analyzeDistress(message:string) {
  if(!process.env.AI_API_KEY) return fallback(message);
  try {
    const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(15_000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.AI_API_KEY}`},body:JSON.stringify({model:process.env.AI_MODEL||'gpt-4o-mini',response_format:{type:'json_object'},messages:[{role:'system',content:'Extract maritime distress data. Return JSON with severity (INFO, WARNING, HIGH, CRITICAL), issue, injuryCount integer, cargoDamagePercent number or null, requiresAssistance boolean, summary.'},{role:'user',content:message}]})});
    if(!response.ok) throw new Error(`AI request ${response.status}`);
    const data:any=await response.json();const raw=JSON.parse(data.choices?.[0]?.message?.content||'{}');return DistressAnalysis.parse({...raw,source:'ai'});
  } catch { return fallback(message); }
}
