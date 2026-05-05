import { useState, useEffect } from "react";

// ─── SUPABASE CONFIG ───────────────────────────────────────────────────────
const SB_URL  = "https://ylneyzemqiksgwjwnbms.supabase.co";
const SB_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsbmV5emVtcWlrc2d3anduYm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NzIwMTAsImV4cCI6MjA5MzU0ODAxMH0.nv3Be1-5BeCeKAeXUoVzhLfMUrEaFQLqP9jhIWb6t1M";
const TABLE   = "bagnini_preferenze";

const H = {
  "Content-Type": "application/json",
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Prefer": "return=representation",
};

async function sbGet(nome) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?nome=eq.${encodeURIComponent(nome)}&select=*`, { headers: H });
  const d = await r.json();
  return d?.[0] || null;
}

async function sbUpsert(nome, absent, shifts) {
  const body = JSON.stringify({ nome, absent, shifts, aggiornato_il: new Date().toISOString() });
  // Try update first
  const upd = await fetch(`${SB_URL}/rest/v1/${TABLE}?nome=eq.${encodeURIComponent(nome)}`, {
    method: "PATCH", headers: H, body,
  });
  const updData = await upd.json();
  if (Array.isArray(updData) && updData.length > 0) return updData[0];
  // Insert if not exists
  const ins = await fetch(`${SB_URL}/rest/v1/${TABLE}`, { method: "POST", headers: H, body });
  return (await ins.json())?.[0];
}

async function sbAll() {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=*&order=aggiornato_il.desc`, { headers: H });
  return await r.json();
}

// ─── CALENDAR CONFIG ───────────────────────────────────────────────────────
const YEAR = 2025;
const MONTHS = [
  { id: 6, name: "Giugno",    short: "GIU", days: 30 },
  { id: 7, name: "Luglio",    short: "LUG", days: 31 },
  { id: 8, name: "Agosto",    short: "AGO", days: 31 },
  { id: 9, name: "Settembre", short: "SET", days: 30 },
];
const WEEK_ORDER  = [1,2,3,4,5,6,0];
const WEEK_LABELS = ["LUN","MAR","MER","GIO","VEN","SAB","DOM"];
const ADMIN_CODE  = "piscina2025";

function getDow(month, day) { return new Date(YEAR, month - 1, day).getDay(); }
function isWE(month, day)   { const d = getDow(month,day); return d===0||d===6; }

function getShifts(dow) {
  if (dow === 4) return [
    { id:"A", label:"11:00 – 18:00", color:"#16a34a", text:"#fff" },
  ];
  if (dow === 6 || dow === 0) return [
    { id:"A", label:"09:00 – 15:30", color:"#16a34a", text:"#fff" },
    { id:"B", label:"15:30 – 20:30", color:"#065f46", text:"#fff" },
  ];
  return [
    { id:"A", label:"11:00 – 15:00", color:"#16a34a", text:"#fff" },
    { id:"B", label:"15:00 – 20:00", color:"#065f46", text:"#fff" },
    { id:"C", label:"11:00 – 20:00", color:"#052e16", text:"#86efac" },
  ];
}

function shiftLabel(dow, sid) {
  if (dow === 4) return "11–18";
  if (dow === 6 || dow === 0) return sid === "A" ? "9–15:30" : "15:30–20:30";
  return sid === "A" ? "11–15" : sid === "B" ? "15–20" : "11–20";
}

function buildWeeks(month) {
  const total = MONTHS.find(m=>m.id===month).days;
  const weeks = []; let week = Array(7).fill(null);
  for (let day=1; day<=total; day++) {
    const col = WEEK_ORDER.indexOf(getDow(month,day));
    week[col] = day;
    if (col===6 || day===total) { weeks.push([...week]); week=Array(7).fill(null); }
  }
  return weeks;
}

// ─── STEP 1 — ASSENZE ─────────────────────────────────────────────────────
function StepAbsent({ name, absent, setAbsent, onNext }) {
  const [mi, setMi] = useState(0);
  const m = MONTHS[mi];
  const weeks = buildWeeks(m.id);
  const absentSet = new Set(absent[m.id]||[]);
  const totalOff = Object.values(absent).reduce((a,v)=>a+(v?.length||0),0);

  function toggle(day) {
    const s = new Set(absent[m.id]||[]);
    s.has(day) ? s.delete(day) : s.add(day);
    setAbsent({...absent,[m.id]:[...s]});
  }

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Turni Estivi 2025</div>
          <div style={S.barName}>{name}</div>
        </div>
        <div style={S.pill}>1 / 2</div>
      </div>
      <div style={S.infoBox}>
        <span style={{fontSize:26}}>🚫</span>
        <div>
          <div style={S.infoTitle}>Segna i giorni in cui sei <em>assente</em></div>
          <div style={S.infoSub}>Tocca i giorni in cui NON puoi lavorare</div>
        </div>
      </div>
      <div style={S.tabs}>
        {MONTHS.map((mo,i)=>{
          const cnt = absent[mo.id]?.length||0;
          return (
            <button key={mo.id} onClick={()=>setMi(i)} style={{...S.tab,...(i===mi?S.tabOn:{})}}>
              {mo.short}
              {cnt>0 && <span style={{...S.badge,background:"#e63946"}}>{cnt}</span>}
            </button>
          );
        })}
      </div>
      <div style={S.cal}>
        <div style={S.calTitle}>{m.name} 2025</div>
        <div style={S.row}>
          {WEEK_LABELS.map((l,i)=>(
            <div key={i} style={{...S.hdr,...(i>=5?S.hdrWE:{})}}>{l}</div>
          ))}
        </div>
        {weeks.map((wk,wi)=>(
          <div key={wi} style={S.row}>
            {wk.map((day,ci)=>{
              if(!day) return <div key={ci} style={{flex:1}}/>;
              const off = absentSet.has(day);
              const we  = isWE(m.id,day);
              return (
                <button key={ci} onClick={()=>toggle(day)} style={{
                  ...S.cell,...(we?S.cellWE:{}),...(off?S.cellOff:{}),
                }}>
                  <span style={S.cellNum}>{day}</span>
                  {off && <span style={{fontSize:9,color:"#e63946",fontWeight:800}}>✕</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div style={S.footer}>
        <div style={{color:"#666",fontSize:12,textAlign:"center"}}>
          {totalOff>0?`${totalOff} giorni assente segnati`:"Tocca un giorno per marcarlo come assente"}
        </div>
        <button onClick={onNext} style={S.btnY}>Avanti → Preferenze turni</button>
      </div>
    </div>
  );
}

// ─── STEP 2 — TURNI ───────────────────────────────────────────────────────
function StepShifts({ name, absent, shifts, setShifts, onBack, onSubmit, saving }) {
  const [mi, setMi] = useState(0);
  const m = MONTHS[mi];
  const weeks = buildWeeks(m.id);
  const absentSet = new Set(absent[m.id]||[]);
  const mShifts   = shifts[m.id]||{};

  function toggleShift(day,sid) {
    const cur = mShifts[day]?.[0];
    const next = cur === sid ? [] : [sid];
    setShifts({...shifts,[m.id]:{...mShifts,[day]:next}});
  }

  const totalPref = Object.values(shifts).reduce((a,ms)=>
    a+Object.values(ms||{}).reduce((b,arr)=>b+(arr?.length>0?1:0),0),0);

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Turni Estivi 2025</div>
          <div style={S.barName}>{name}</div>
        </div>
        <div style={S.pill}>2 / 2</div>
      </div>
      <div style={S.infoBox}>
        <span style={{fontSize:26}}>⏰</span>
        <div>
          <div style={S.infoTitle}>Indica i turni <em>preferiti</em></div>
          <div style={S.infoSub}>Un turno per giorno. Gio: 11–18 · Sab/Dom: 09–15:30 o 15:30–20:30.</div>
        </div>
      </div>
      <div style={S.tabs}>
        {MONTHS.map((mo,i)=>{
          const filled = Object.values(shifts[mo.id]||{}).filter(a=>a?.length>0).length;
          return (
            <button key={mo.id} onClick={()=>setMi(i)} style={{...S.tab,...(i===mi?S.tabOn:{})}}>
              {mo.short}
              {filled>0 && <span style={{...S.badge,background:"#16a34a"}}>{filled}</span>}
            </button>
          );
        })}
      </div>
      <div style={S.cal}>
        <div style={S.calTitle}>{m.name} 2025</div>
        <div style={S.row}>
          {WEEK_LABELS.map((l,i)=>(
            <div key={i} style={{...S.hdr,...(i>=5?S.hdrWE:{})}}>{l}</div>
          ))}
        </div>
        {weeks.map((wk,wi)=>(
          <div key={wi} style={{...S.row,alignItems:"stretch"}}>
            {wk.map((day,ci)=>{
              if(!day) return <div key={ci} style={{flex:1}}/>;
              const off = absentSet.has(day);
              const we  = isWE(m.id,day);
              const dow = getDow(m.id,day);
              const dayShifts = getShifts(dow);
              const selected  = mShifts[day]?.[0];

              if(off) return (
                <div key={ci} style={{...S.cell,...S.cellOff,cursor:"default",height:"auto",padding:"4px 2px",display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  <span style={S.cellNum}>{day}</span>
                  <span style={{fontSize:8,color:"#e63946",fontWeight:800}}>OFF</span>
                </div>
              );

              return (
                <div key={ci} style={{flex:1,background:we?"#2a2500":"#2a2a2a",borderRadius:6,padding:"4px 2px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,minWidth:0}}>
                  <span style={{...S.cellNum,...(we?{color:"#F5C200"}:{})}}>{day}</span>
                  {dayShifts.map(s=>{
                    const on = selected===s.id;
                    return (
                      <button key={s.id} onClick={()=>toggleShift(day,s.id)} style={{
                        width:"100%",padding:"3px 1px",borderRadius:4,
                        border: on?`2px solid ${s.color}`:"2px solid #3a3a3a",
                        background: on?s.color:"#1a1a1a",
                        color: on?s.text:"#555",
                        fontSize:7,fontWeight:800,cursor:"pointer",
                        fontFamily:"'Josefin Sans',sans-serif",lineHeight:1.3,textAlign:"center",
                      }}>
                        {shiftLabel(dow,s.id)}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div style={S.footer}>
        <div style={{color:"#666",fontSize:12,textAlign:"center"}}>
          {totalPref>0?`${totalPref} preferenze inserite`:"Seleziona il turno preferito per ogni giorno"}
        </div>
        <button onClick={onSubmit} disabled={saving} style={{...S.btnY,background:saving?"#444":"#16a34a",color:"#fff"}}>
          {saving ? "Salvataggio…" : "✓ Conferma e salva"}
        </button>
      </div>
    </div>
  );
}

// ─── DONE ─────────────────────────────────────────────────────────────────
function Done({ name, onEdit }) {
  return (
    <div style={{...S.page,alignItems:"center",justifyContent:"center",textAlign:"center",padding:32}}>
      <div style={{fontSize:60,marginBottom:16}}>🌊</div>
      <div style={{color:"#F5C200",fontSize:10,letterSpacing:3,fontWeight:700,marginBottom:6}}>ASC HOTEL · PISCINA</div>
      <div style={{color:"#fff",fontSize:28,fontWeight:800,marginBottom:10}}>Grazie, {name}!</div>
      <div style={{color:"#555",fontSize:14,maxWidth:280,lineHeight:1.8,marginBottom:36}}>
        Le tue preferenze sono state salvate.<br/>Puoi rientrare in qualsiasi momento per modificarle.
      </div>
      <button onClick={onEdit} style={{...S.btnY,background:"transparent",border:"2px solid #333",color:"#888",fontSize:13,padding:"12px 28px"}}>
        ✏️ Modifica preferenze
      </button>
    </div>
  );
}

// ─── ADMIN ────────────────────────────────────────────────────────────────
function Admin({ onBack }) {
  const [mi, setMi]       = useState(0);
  const [data, setData]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied]   = useState(false);
  const [view, setView]       = useState("calendar"); // calendar | export

  useEffect(()=>{
    sbAll().then(d=>{ setData(Array.isArray(d)?d:[]); setLoading(false); });
  },[]);

  const m = MONTHS[mi];
  const weeks = buildWeeks(m.id);
  const names = data.map(r=>r.nome);

  function dayInfo(day) {
    const dow = getDow(m.id,day);
    const defs = getShifts(dow);
    const byShift = {}; defs.forEach(s=>byShift[s.id]=[]);
    const off=[];
    data.forEach(r=>{
      const isOff = (r.absent?.[m.id]||[]).includes(day);
      if(isOff){off.push(r.nome);return;}
      (r.shifts?.[m.id]?.[day]||[]).forEach(sid=>{if(byShift[sid]) byShift[sid].push(r.nome);});
    });
    const total = Object.values(byShift).flat().length;
    return {byShift,off,defs,dow,total};
  }

  function covBg(day) {
    const {total}=dayInfo(day);
    if(total===0) return "#2a1010";
    if(total===1) return "#2a2800";
    return "#0a2a10";
  }

  // Build export text for Claude analysis
  function buildExport() {
    let txt = `# Preferenze Turni Bagnini — Estate 2025\n\n`;
    txt += `Bagnini: ${names.join(", ")}\n\n`;
    txt += `## Turni per fascia oraria:\n`;
    txt += `- Lun/Mar/Mer/Ven: A=11–15, B=15–20, C=11–20\n`;
    txt += `- Giovedì: A=11–18\n`;
    txt += `- Sab/Dom: A=09–15:30, B=15:30–20:30\n\n`;
    MONTHS.forEach(mo=>{
      txt += `## ${mo.name}\n`;
      for(let day=1; day<=mo.days; day++){
        const dow = getDow(mo.id,day);
        const dowNames=["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];
        const date = `${mo.name.substring(0,3)} ${day} (${dowNames[dow]})`;
        const defs = getShifts(dow);
        const byShift={}; defs.forEach(s=>byShift[s.id]=[]);
        const off=[];
        data.forEach(r=>{
          const isOff=(r.absent?.[mo.id]||[]).includes(day);
          if(isOff){off.push(r.nome);return;}
          (r.shifts?.[mo.id]?.[day]||[]).forEach(sid=>{if(byShift[sid])byShift[sid].push(r.nome);});
        });
        const lines=[];
        defs.forEach(s=>{
          if(byShift[s.id].length) lines.push(`${shiftLabel(dow,s.id)}: ${byShift[s.id].join(", ")}`);
        });
        if(off.length) lines.push(`ASSENTI: ${off.join(", ")}`);
        if(lines.length) txt+=`- ${date}: ${lines.join(" | ")}\n`;
        else txt+=`- ${date}: nessuna disponibilità\n`;
      }
      txt+="\n";
    });
    return txt;
  }

  function copyExport() {
    navigator.clipboard.writeText(buildExport()).then(()=>{
      setCopied(true); setTimeout(()=>setCopied(false),2500);
    });
  }

  if(loading) return (
    <div style={{...S.page,alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#F5C200",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento dati…</div>
    </div>
  );

  return (
    <div style={{...S.page,background:"#0d0d0d"}}>
      <div style={{...S.bar,borderBottom:"2px solid #F5C200"}}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Admin · ASC Hotel Piscina</div>
          <div style={S.barName}>Turni 2025</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setView("calendar")} style={{...S.pill,cursor:"pointer",background:view==="calendar"?"#F5C200":"#2a2a2a",color:view==="calendar"?"#1a1a1a":"#666"}}>📅</button>
          <button onClick={()=>setView("export")}   style={{...S.pill,cursor:"pointer",background:view==="export"?"#16a34a":"#2a2a2a",color:view==="export"?"#fff":"#666"}}>AI</button>
        </div>
      </div>

      {/* Staff chips */}
      <div style={{padding:"10px 14px",display:"flex",gap:6,flexWrap:"wrap"}}>
        {data.map(r=>{
          const tot = MONTHS.reduce((a,mo)=>{
            const wk = buildWeeks(mo.id).flat().filter(d=>d&&!(r.absent?.[mo.id]||[]).includes(d));
            return a+wk.filter(d=>(r.shifts?.[mo.id]?.[d]?.length||0)>0).length;
          },0);
          const upd = r.aggiornato_il ? new Date(r.aggiornato_il).toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit"}) : "—";
          return (
            <div key={r.nome} style={{background:"#1a1a1a",border:"1px solid #2a2a2a",borderRadius:8,padding:"6px 12px"}}>
              <div style={{color:"#F5C200",fontSize:12,fontWeight:700}}>{r.nome}</div>
              <div style={{color:"#444",fontSize:9}}>{tot} preferenze · agg. {upd}</div>
            </div>
          );
        })}
        {data.length===0 && <div style={{color:"#333",fontSize:12}}>Nessun dato ancora</div>}
      </div>

      {/* EXPORT VIEW */}
      {view==="export" && (
        <div style={{padding:"12px 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#1a1a1a",border:"1px solid #16a34a",borderRadius:12,padding:"16px"}}>
            <div style={{color:"#16a34a",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:6}}>ANALISI AI CON CLAUDE</div>
            <div style={{color:"#888",fontSize:12,lineHeight:1.7,marginBottom:12}}>
              Copia il report qui sotto e incollalo in una nuova chat con Claude. Chiedi di creare i turni ottimali rispettando le preferenze e garantendo la copertura minima.
            </div>
            <button onClick={copyExport} style={{...S.btnY,background:copied?"#065f46":"#16a34a",color:"#fff",fontSize:13}}>
              {copied ? "✓ Copiato negli appunti!" : "📋 Copia report per Claude"}
            </button>
          </div>
          <div style={{background:"#111",borderRadius:10,padding:"12px",fontFamily:"monospace",fontSize:10,color:"#555",maxHeight:400,overflowY:"auto",lineHeight:1.6,whiteSpace:"pre-wrap"}}>
            {buildExport()}
          </div>
        </div>
      )}

      {/* CALENDAR VIEW */}
      {view==="calendar" && (
        <>
          <div style={{...S.tabs,marginTop:8}}>
            {MONTHS.map((mo,i)=>(
              <button key={mo.id} onClick={()=>setMi(i)} style={{
                ...S.tab,...(i===mi?S.tabOn:{background:"#1a1a1a",color:"#555",border:"2px solid #2a2a2a"}),
              }}>{mo.short}</button>
            ))}
          </div>

          <div style={{display:"flex",gap:12,padding:"8px 14px",flexWrap:"wrap"}}>
            {[["#2a1010","Scoperto"],["#2a2800","1 bagnino"],["#0a2a10","≥2 bagnini"]].map(([c,l])=>(
              <div key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                <div style={{width:10,height:10,background:c,borderRadius:2,border:"1px solid #333"}}/>
                <span style={{color:"#444",fontSize:10}}>{l}</span>
              </div>
            ))}
          </div>

          <div style={{...S.cal,background:"transparent"}}>
            <div style={{...S.calTitle,color:"#F5C200"}}>{m.name} 2025</div>
            <div style={S.row}>
              {WEEK_LABELS.map((l,i)=>(
                <div key={i} style={{...S.hdr,background:"#1a1a1a",color:i>=5?"#F5C200":"#444",border:"1px solid #1e1e1e"}}>{l}</div>
              ))}
            </div>
            {weeks.map((wk,wi)=>(
              <div key={wi} style={{display:"flex",gap:2,marginBottom:2}}>
                {wk.map((day,ci)=>{
                  if(!day) return <div key={ci} style={{flex:1}}/>;
                  const {byShift,off,defs,dow} = dayInfo(day);
                  const we = isWE(m.id,day);
                  return (
                    <div key={ci} style={{flex:1,minWidth:0,background:covBg(day),border:`1px solid ${we?"#2a2200":"#1e1e1e"}`,borderRadius:5,padding:"3px 2px"}}>
                      <div style={{color:we?"#F5C200":"#555",fontSize:9,fontWeight:800,textAlign:"center",marginBottom:2}}>{day}</div>
                      {defs.map(s=>{
                        const ppl=byShift[s.id]||[];
                        if(!ppl.length) return null;
                        return (
                          <div key={s.id} style={{marginBottom:2}}>
                            <div style={{background:s.color,borderRadius:2,padding:"1px 2px",fontSize:7,fontWeight:800,color:s.text,textAlign:"center"}}>{shiftLabel(dow,s.id)}</div>
                            {ppl.map(p=>(
                              <div key={p} style={{background:"#ffffff10",borderRadius:2,padding:"0 2px",fontSize:7,color:"#bbb",textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>
                                {p.split(" ")[0]}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      {off.length>0 && (
                        <div style={{fontSize:6,color:"#e63946",textAlign:"center",marginTop:1}}>
                          {off.map(p=>p.split(" ")[0]).join(",")}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────
const S = {
  page:    {minHeight:"100vh",background:"#1a1a1a",fontFamily:"'Josefin Sans',sans-serif",display:"flex",flexDirection:"column"},
  bar:     {background:"#111",padding:"14px 18px",display:"flex",alignItems:"center",gap:10},
  barLabel:{color:"#F5C200",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"},
  barName: {color:"#fff",fontSize:19,fontWeight:800,lineHeight:1.1},
  pill:    {background:"#2a2a2a",color:"#666",fontSize:9,fontWeight:700,padding:"4px 10px",borderRadius:20,flexShrink:0,letterSpacing:1},
  back:    {background:"none",border:"none",color:"#F5C200",fontSize:22,cursor:"pointer",paddingRight:8},
  infoBox: {display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:"#222",margin:"10px 14px",borderRadius:12},
  infoTitle:{color:"#fff",fontSize:13,fontWeight:700,marginBottom:2},
  infoSub: {color:"#666",fontSize:11},
  tabs:    {display:"flex",gap:6,padding:"0 14px",overflowX:"auto"},
  tab:     {padding:"6px 14px",borderRadius:20,border:"2px solid #333",background:"#2a2a2a",color:"#888",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",whiteSpace:"nowrap",position:"relative",flexShrink:0},
  tabOn:   {border:"2px solid #F5C200",background:"#F5C200",color:"#1a1a1a"},
  badge:   {position:"absolute",top:-6,right:-6,borderRadius:"50%",width:15,height:15,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:"#fff"},
  cal:     {padding:"10px 8px 90px",flex:1},
  calTitle:{color:"#fff",fontSize:15,fontWeight:800,padding:"6px 8px 8px",letterSpacing:0.5},
  row:     {display:"flex",gap:2,marginBottom:2},
  hdr:     {flex:1,textAlign:"center",fontSize:8,fontWeight:800,color:"#444",padding:"4px 0",background:"#222",borderRadius:3,letterSpacing:0.5},
  hdrWE:   {color:"#F5C200"},
  cell:    {flex:1,aspectRatio:"1",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#2a2a2a",borderRadius:6,border:"2px solid transparent",cursor:"pointer",position:"relative",minHeight:36,gap:1},
  cellWE:  {background:"#2a2500"},
  cellOff: {background:"#2a1010",border:"2px solid #e6394640"},
  cellNum: {fontSize:12,fontWeight:800,color:"#fff",lineHeight:1},
  footer:  {position:"fixed",bottom:0,left:0,right:0,padding:"10px 14px",background:"#111",borderTop:"1px solid #222",display:"flex",flexDirection:"column",gap:6},
  btnY:    {padding:"13px",background:"#F5C200",color:"#1a1a1a",border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"},
};

// ─── APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]   = useState("home");
  const [name,setName]       = useState("");
  const [nameErr,setNameErr] = useState("");
  const [absent,setAbsent]   = useState({});
  const [shifts,setShifts]   = useState({});
  const [saving,setSaving]   = useState(false);
  const [adminPw,setAdminPw] = useState("");
  const [adminErr,setAdminErr]= useState("");

  async function handleStart() {
    const n = name.trim();
    if(!n) return setNameErr("Inserisci il tuo nome e cognome");
    setNameErr("");
    // Load existing data from Supabase
    const existing = await sbGet(n);
    if(existing) { setAbsent(existing.absent||{}); setShifts(existing.shifts||{}); }
    else          { setAbsent({}); setShifts({}); }
    setScreen("step1");
  }

  async function handleSubmit() {
    setSaving(true);
    await sbUpsert(name.trim(), absent, shifts);
    setSaving(false);
    setScreen("done");
  }

  function tryAdmin() {
    if(adminPw===ADMIN_CODE){ setScreen("admin"); setAdminErr(""); }
    else setAdminErr("Codice non corretto");
  }

  if(screen==="step1") return <StepAbsent name={name.trim()} absent={absent} setAbsent={setAbsent} onNext={()=>setScreen("step2")}/>;
  if(screen==="step2") return <StepShifts name={name.trim()} absent={absent} shifts={shifts} setShifts={setShifts} onBack={()=>setScreen("step1")} onSubmit={handleSubmit} saving={saving}/>;
  if(screen==="done")  return <Done name={name.trim()} onEdit={()=>setScreen("step1")}/>;
  if(screen==="admin") return <Admin onBack={()=>setScreen("home")}/>;

  if(screen==="adminLogin") return (
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'Josefin Sans',sans-serif",padding:24}}>
      <div style={{color:"#F5C200",fontSize:10,letterSpacing:3,fontWeight:700,marginBottom:6}}>AREA RISERVATA</div>
      <div style={{color:"#fff",fontSize:24,fontWeight:800,marginBottom:28}}>Admin · Piscina 2025</div>
      <input type="password" placeholder="Codice accesso" value={adminPw} onChange={e=>setAdminPw(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&tryAdmin()}
        style={{width:"100%",maxWidth:300,padding:"12px 16px",borderRadius:8,border:"2px solid #333",background:"#2a2a2a",color:"#fff",fontSize:15,fontFamily:"'Josefin Sans',sans-serif",outline:"none",marginBottom:8,boxSizing:"border-box"}}/>
      {adminErr && <div style={{color:"#e63946",fontSize:12,marginBottom:8}}>{adminErr}</div>}
      <button onClick={tryAdmin} style={{width:"100%",maxWidth:300,padding:13,background:"#F5C200",color:"#1a1a1a",border:"none",borderRadius:8,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Accedi</button>
      <button onClick={()=>setScreen("home")} style={{marginTop:14,background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:12,fontFamily:"'Josefin Sans',sans-serif"}}>← Indietro</button>
    </div>
  );

  // HOME
  return (
    <div style={{minHeight:"100vh",background:"#1a1a1a",fontFamily:"'Josefin Sans',sans-serif",display:"flex",flexDirection:"column"}}>
      <div style={{background:"linear-gradient(150deg,#1a1a1a 55%,#0a1a0a)",padding:"44px 26px 36px",borderBottom:"3px solid #F5C200"}}>
        <div style={{color:"#F5C200",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>ASC Hotel · Piscina</div>
        <div style={{color:"#fff",fontSize:38,fontWeight:800,lineHeight:1.0,marginBottom:8}}>Turni<br/>Estivi 2025</div>
        <div style={{color:"#555",fontSize:12,letterSpacing:1}}>GIU · LUG · AGO · SET</div>
      </div>
      <div style={{padding:"32px 22px",flex:1,display:"flex",flexDirection:"column",gap:18}}>
        <div>
          <div style={{color:"#555",fontSize:10,fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Il tuo nome</div>
          <input
            placeholder="Es. Marco Rossi"
            value={name}
            onChange={e=>{setName(e.target.value);setNameErr("");}}
            onKeyDown={e=>e.key==="Enter"&&handleStart()}
            style={{width:"100%",padding:"14px 16px",borderRadius:10,border:`2px solid ${nameErr?"#e63946":"#2a2a2a"}`,background:"#2a2a2a",color:"#fff",fontSize:16,fontFamily:"'Josefin Sans',sans-serif",outline:"none",boxSizing:"border-box"}}
          />
          {nameErr && <div style={{color:"#e63946",fontSize:12,marginTop:5}}>{nameErr}</div>}
          <div style={{color:"#444",fontSize:11,marginTop:6}}>Se hai già inserito le preferenze, il tuo nome le ricaricherà automaticamente.</div>
        </div>
        <button onClick={handleStart} style={{...S.btnY,fontSize:16}}>Inizia →</button>
        <div style={{borderTop:"1px solid #222",paddingTop:22}}>
          <button onClick={()=>setScreen("adminLogin")} style={{width:"100%",padding:12,background:"transparent",color:"#F5C200",border:"2px solid #2a2a2a",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
            🔒 Area Admin
          </button>
        </div>
      </div>
    </div>
  );
}
