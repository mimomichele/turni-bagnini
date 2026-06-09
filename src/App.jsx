import { useState, useEffect, useRef } from "react";

// ─── SUPABASE CONFIG ───────────────────────────────────────────────────────
const SB_URL      = import.meta.env.VITE_SUPABASE_URL;
const SB_KEY      = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SB_ADMIN_KEY= import.meta.env.VITE_SUPABASE_SERVICE_KEY;
const TABLE       = "bagnini_preferenze";

const H = {
  "Content-Type": "application/json",
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Prefer": "return=representation",
};

// Admin headers with service role key — bypasses RLS
const H_ADMIN = {
  "Content-Type": "application/json",
  "apikey": SB_ADMIN_KEY,
  "Authorization": `Bearer ${SB_ADMIN_KEY}`,
  "Prefer": "return=representation",
};

// ─── COWORKING SUPABASE (progetto separato) ────────────────────────────────
const CW_URL = import.meta.env.VITE_COWORKING_SUPABASE_URL;
const CW_KEY = import.meta.env.VITE_COWORKING_ANON_KEY;
const H_CW = {
  "Content-Type": "application/json",
  "apikey": CW_KEY,
  "Authorization": `Bearer ${CW_KEY}`,
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
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=*&order=aggiornato_il.desc`, {
      headers: H,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) {
    console.error("sbAll error:", e);
    return [];
  }
}

// Admin-only patch / delete on bagnini_preferenze (used by the merge tool).
async function sbDeleteRow(nome) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?nome=eq.${encodeURIComponent(nome)}`, {
    method: "DELETE", headers: H_ADMIN,
  });
  if(!r.ok) throw new Error(`sbDeleteRow ${nome}: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json().catch(()=>[]);
}
async function sbPatchRaw(nome, payload) {
  const body = JSON.stringify({ ...payload, aggiornato_il: new Date().toISOString() });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?nome=eq.${encodeURIComponent(nome)}`, {
    method: "PATCH", headers: H_ADMIN, body,
  });
  if(!r.ok) throw new Error(`sbPatchRaw ${nome}: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json().catch(()=>[]);
}

// ─── TURNI CONFERMATI API ─────────────────────────────────────────────────
const TABLE_TC = "turni_confermati";

// Hours per shift type derived from getShifts() definitions
function shiftHours(dow, sid) {
  if (dow === 4) return 6;                          // Giovedì 12-18
  if (dow === 6 || dow === 0) return sid === "C" ? 11 : 5.5; // Sab/Dom A=9-14:30, B=14:30-20, C=9-20
  return 7;                                          // Lun/Mar/Mer/Ven 12-19
}

function pad2(n){ return String(n).padStart(2,"0"); }
function dateStrOf(monthId, day) { return `${YEAR}-${pad2(monthId)}-${pad2(day)}`; }

async function tcAll() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}?select=*&order=data.asc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("tcAll",e); return []; }
}

// Atomic replace: delete all rows for date, then insert the new ones.
// Uses the anon key (H) — requires an RLS policy on turni_confermati allowing
// insert/delete to anon. Errors are surfaced (not swallowed) so the UI can react.
async function tcReplaceForDay(date, assignments) {
  const delResp = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}?data=eq.${date}`, { method:"DELETE", headers: H });
  if(!delResp.ok) {
    const txt = await delResp.text().catch(()=>"");
    console.error("tcReplaceForDay DELETE failed", delResp.status, txt);
    throw new Error(`DELETE failed: ${delResp.status} ${txt}`);
  }
  if(!assignments.length) return [];
  const body = JSON.stringify(assignments.map(a => ({
    data: date,
    bagnino: a.bagnino,
    turno: a.turno,
    ore: a.ore,
    aggiornato_il: new Date().toISOString(),
  })));
  const insResp = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}`, { method:"POST", headers: H, body });
  if(!insResp.ok) {
    const txt = await insResp.text().catch(()=>"");
    console.error("tcReplaceForDay INSERT failed", insResp.status, txt);
    throw new Error(`INSERT failed: ${insResp.status} ${txt}`);
  }
  return await insResp.json();
}

async function tcBulkInsert(rows) {
  if(!rows.length) return [];
  const body = JSON.stringify(rows.map(r => ({...r, aggiornato_il: new Date().toISOString()})));
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}`, { method:"POST", headers: H, body });
  if(!r.ok) {
    const txt = await r.text().catch(()=>"");
    console.error("tcBulkInsert failed", r.status, txt);
    throw new Error(`Bulk insert failed: ${r.status} ${txt}`);
  }
  return await r.json();
}
// Bulk-rename: change bagnino on every turni_confermati row matching `from`
async function tcRenameBagnino(from, to) {
  const body = JSON.stringify({ bagnino: to, aggiornato_il: new Date().toISOString() });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}?bagnino=eq.${encodeURIComponent(from)}`, {
    method:"PATCH", headers: H, body,
  });
  if(!r.ok) throw new Error(`tcRenameBagnino: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json().catch(()=>[]);
}

// ─── RICHIESTE ORE API ────────────────────────────────────────────────────
const TABLE_RO = "richieste_ore";

async function roAll() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}?select=*&order=creata_il.desc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("roAll",e); return []; }
}
async function roForBagnino(bagnino) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}?bagnino=eq.${encodeURIComponent(bagnino)}&select=*&order=creata_il.desc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("roForBagnino",e); return []; }
}
async function roPendingCount() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}?stato=eq.pending&select=id`, { headers: H });
    if(!r.ok) return 0;
    const d = await r.json();
    return Array.isArray(d) ? d.length : 0;
  } catch(e) { console.error("roPendingCount",e); return 0; }
}
async function roCreate({ bagnino, data, turno, ore_confermate, ore_richieste, motivo }) {
  const body = JSON.stringify({
    bagnino, data, turno,
    ore_confermate, ore_richieste, motivo,
    stato: "pending",
  });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}`, { method:"POST", headers: H, body });
  if(!r.ok) throw new Error(`POST richieste_ore: ${r.status} ${await r.text().catch(()=>"")}`);
  return (await r.json())?.[0];
}
async function roReject(id, nota) {
  const body = JSON.stringify({
    stato: "rifiutata",
    gestita_il: new Date().toISOString(),
    nota_admin: nota && nota.trim() ? nota.trim() : null,
  });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}?id=eq.${id}`, { method:"PATCH", headers: H, body });
  if(!r.ok) throw new Error(`PATCH richieste_ore: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json();
}
// ─── COWORKING BOOKINGS + CHECK-IN ────────────────────────────────────────
const TABLE_CI = "checkin_ingressi";

// Today's bookings from the separate coworking Supabase project.
// Joins members via PostgREST embedding to get name + surname.
async function cwBookingsToday() {
  if (!CW_URL || !CW_KEY) {
    throw new Error("Manca la configurazione coworking (VITE_COWORKING_SUPABASE_URL / VITE_COWORKING_ANON_KEY).");
  }
  const today = todayISO();
  // bookings has two FKs into members → disambiguate the embed with the
  // explicit FK constraint name (bookings_member_id_fkey).
  const r = await fetch(
    `${CW_URL}/rest/v1/bookings?date=eq.${today}&status=neq.cancelled` +
    `&select=id,date,status,created_at,members!bookings_member_id_fkey(name,surname)` +
    `&order=created_at.asc`,
    { headers: H_CW }
  );
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`Errore lettura coworking (${r.status}): ${txt || "verifica RLS su bookings/members"}`);
  }
  return await r.json();
}

async function ciTodayCheckins() {
  const r = await fetch(
    `${SB_URL}/rest/v1/${TABLE_CI}?data=eq.${todayISO()}&select=*&order=ora_checkin.desc`,
    { headers: H }
  );
  if (!r.ok) throw new Error(`Errore check-ins: ${r.status}`);
  return await r.json();
}

async function ciCheckin({ nome_membro, bagnino_nome }) {
  const body = JSON.stringify({
    nome_membro,
    bagnino_nome,
    ora_checkin: new Date().toISOString(),
  });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CI}`, { method:"POST", headers: H, body });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error(`Errore check-in (${r.status}): ${txt}`);
  }
  return (await r.json())?.[0];
}

// Approve: bump ore on the matching turni_confermati row(s), then flag request as approved.
async function roApprove(req) {
  const tcBody = JSON.stringify({
    ore: req.ore_richieste,
    aggiornato_il: new Date().toISOString(),
  });
  const tcResp = await fetch(
    `${SB_URL}/rest/v1/${TABLE_TC}?bagnino=eq.${encodeURIComponent(req.bagnino)}&data=eq.${req.data}&turno=eq.${encodeURIComponent(req.turno)}`,
    { method:"PATCH", headers: H, body: tcBody }
  );
  if(!tcResp.ok) throw new Error(`PATCH turni_confermati: ${tcResp.status} ${await tcResp.text().catch(()=>"")}`);
  const roBody = JSON.stringify({
    stato: "approvata",
    gestita_il: new Date().toISOString(),
  });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_RO}?id=eq.${req.id}`, { method:"PATCH", headers: H, body: roBody });
  if(!r.ok) throw new Error(`PATCH richieste_ore: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json();
}

// ─── CHECKLIST API ─────────────────────────────────────────────────────────
const TABLE_CK_TASKS = "checklist_tasks";
const TABLE_CK_COMP  = "checklist_completamenti";

const CK_CATS = [
  { id:"INGRESSO",   label:"Ingresso",        sublabel:"Turno mattina",       icon:"🌅", color:"#2563eb", daily:true  },
  { id:"USCITA",     label:"Uscita",          sublabel:"Turno sera",          icon:"🌇", color:"#f59e0b", daily:true  },
  { id:"PERIODICHE", label:"Periodiche",      sublabel:"Reset manuale admin", icon:"🔁", color:"#9333ea", daily:false },
  { id:"OCCORRENZA", label:"All'occorrenza",  sublabel:"Su necessità",        icon:"⚡", color:"#16a34a", daily:false },
];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function hhmm(iso) {
  if(!iso) return "";
  return new Date(iso).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
}
function ddmm(iso) {
  if(!iso) return "";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
}
function dateLabel(iso) {
  if(!iso) return "";
  return new Date(iso).toLocaleString("it-IT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
}

async function ckTasks() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_TASKS}?select=*&attivo=eq.true&order=categoria.asc,ordine.asc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("ckTasks",e); return []; }
}
async function ckCompletionsByDate(date) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?select=*&data=eq.${date}&order=completato_alle.desc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("ckCompletionsByDate",e); return []; }
}
async function ckCompletionsForTasks(taskIds) {
  if(!taskIds.length) return [];
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?select=*&task_id=in.(${taskIds.join(",")})&order=completato_alle.desc`, { headers: H });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { console.error("ckCompletionsForTasks",e); return []; }
}
async function ckComplete(task_id, bagnino) {
  const body = JSON.stringify({ task_id, bagnino, data: todayISO(), completato_alle: new Date().toISOString() });
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}`, { method:"POST", headers: H, body });
    return (await r.json())?.[0];
  } catch(e) { console.error("ckComplete",e); return null; }
}
async function ckDeleteCompletion(id) {
  try { await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?id=eq.${id}`, { method:"DELETE", headers: H }); }
  catch(e) { console.error("ckDeleteCompletion",e); }
}
async function ckDeleteCompletionsTodayForTask(task_id) {
  try { await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?task_id=eq.${task_id}&data=eq.${todayISO()}`, { method:"DELETE", headers: H }); }
  catch(e) { console.error("ckDeleteCompletionsTodayForTask",e); }
}
// Admin ops (use service key)
async function ckAddTask({ categoria, titolo, ordine }) {
  const body = JSON.stringify({ categoria, titolo, ordine: ordine||0, attivo: true });
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_TASKS}`, { method:"POST", headers: H_ADMIN, body });
    return (await r.json())?.[0];
  } catch(e) { console.error("ckAddTask",e); return null; }
}
// Soft delete: attivo=false (preserves history of completamenti)
async function ckDeleteTask(id) {
  const body = JSON.stringify({ attivo: false });
  try { await fetch(`${SB_URL}/rest/v1/${TABLE_CK_TASKS}?id=eq.${id}`, { method:"PATCH", headers: H_ADMIN, body }); }
  catch(e) { console.error("ckDeleteTask",e); }
}
// Patch an existing task (e.g. frequenza_giorni)
async function ckUpdateTask(id, patch) {
  try {
    const body = JSON.stringify(patch);
    await fetch(`${SB_URL}/rest/v1/${TABLE_CK_TASKS}?id=eq.${id}`, { method:"PATCH", headers: H_ADMIN, body });
  } catch(e) { console.error("ckUpdateTask",e); }
}
// Reset: delete ALL completamenti for every task in the category (no date filter)
async function ckResetCategory(categoria) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_TASKS}?select=id&attivo=eq.true&categoria=eq.${categoria}`, { headers: H });
    const tasks = await r.json();
    const ids = (tasks||[]).map(t => t.id);
    if(!ids.length) return;
    await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?task_id=in.(${ids.join(",")})`, { method:"DELETE", headers: H_ADMIN });
  } catch(e) { console.error("ckResetCategory",e); }
}
// Bulk-rename: change bagnino on every checklist_completamenti row matching `from`
async function ckRenameBagnino(from, to) {
  const body = JSON.stringify({ bagnino: to });
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE_CK_COMP}?bagnino=eq.${encodeURIComponent(from)}`, {
    method:"PATCH", headers: H, body,
  });
  if(!r.ok) throw new Error(`ckRenameBagnino: ${r.status} ${await r.text().catch(()=>"")}`);
  return await r.json().catch(()=>[]);
}

// Returns the completion that counts as "done" for a task, or null.
// Daily categories (INGRESSO/USCITA) → must match the given date (or today).
// Periodic categories → any completion makes the task done; reset clears all rows.
// PERIODICHE with frequenza_giorni → completion "expires" after N days:
//   - while fresh: returns the completion with extra _locked=true and
//     _nextDue=ISO date of when it becomes due again (non-clickable for users).
//   - when expired: returns null (task is "todo" again, no manual reset needed).
function taskStatus(task, completions, date) {
  const d = date || todayISO();
  if (task.categoria === "INGRESSO" || task.categoria === "USCITA") {
    const c = completions.find(x => x.task_id === task.id && x.data === d);
    return c || null;
  }
  const cs = completions.filter(x => x.task_id === task.id);
  if(!cs.length) return null;
  const latest = cs.slice().sort((a,b)=>new Date(b.completato_alle)-new Date(a.completato_alle))[0];
  if (task.categoria === "PERIODICHE" && task.frequenza_giorni && Number(task.frequenza_giorni) > 0) {
    const due = new Date(latest.completato_alle);
    due.setDate(due.getDate() + Number(task.frequenza_giorni));
    if (due.getTime() <= Date.now()) return null;          // expired → reappears as todo
    return { ...latest, _locked: true, _nextDue: due.toISOString() };
  }
  return latest;
}

// ─── CALENDAR CONFIG ───────────────────────────────────────────────────────
const YEAR = 2026;
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
  if (dow === 4) return [  // Giovedì
    { id:"A", label:"12:00 – 18:00", color:"#16a34a", text:"#fff" },
  ];
  if (dow === 6 || dow === 0) return [  // Sabato e Domenica
    { id:"A", label:"09:00 – 14:30", color:"#16a34a", text:"#fff" },
    { id:"B", label:"14:30 – 20:00", color:"#065f46", text:"#fff" },
    { id:"C", label:"09:00 – 20:00", color:"#052e16", text:"#86efac" },
  ];
  return [  // Lun Mar Mer Ven
    { id:"A", label:"12:00 – 19:00", color:"#16a34a", text:"#fff" },
  ];
}

function shiftLabel(dow, sid) {
  if (dow === 4) return "12–18";
  if (dow === 6 || dow === 0) return sid === "A" ? "9–14:30" : sid === "B" ? "14:30–20" : "9–20";
  return "12–19";
}

// Deterministic color per name (used for staff avatars + dots)
function nameColor(nome) {
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360}, 65%, 48%)`;
}
function nameInitials(nome) {
  const parts = nome.trim().split(/\s+/);
  const a = parts[0]?.[0] || "";
  const b = parts[1]?.[0] || "";
  return (a + b).toUpperCase();
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
function StepAbsent({ name, absent, setAbsent, onNext, bagniniNames, onNameChange }) {
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
        <div style={{flex:1,minWidth:0}}>
          <div style={S.barLabel}>Turni Estivi 2026</div>
          <select value={name} onChange={e=>onNameChange(e.target.value)} style={{color:"#1a1a1a",fontSize:17,fontWeight:800,fontFamily:"'Josefin Sans',sans-serif",background:"#fff",border:"none",borderBottom:"2px dashed #F5C200",outline:"none",cursor:"pointer",padding:"2px 0",lineHeight:1.2,maxWidth:"100%"}}>
            {!(bagniniNames||[]).includes(name) && name && <option value={name}>{name} (rimosso)</option>}
            {(bagniniNames||[]).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
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
        <div style={S.calTitle}>{m.name} 2026</div>
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
function StepShifts({ name, absent, shifts, setShifts, onBack, onSubmit, saving, bagniniNames, onNameChange }) {
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
        <div style={{flex:1,minWidth:0}}>
          <div style={S.barLabel}>Turni Estivi 2026</div>
          <select value={name} onChange={e=>onNameChange(e.target.value)} style={{color:"#1a1a1a",fontSize:17,fontWeight:800,fontFamily:"'Josefin Sans',sans-serif",background:"#fff",border:"none",borderBottom:"2px dashed #F5C200",outline:"none",cursor:"pointer",padding:"2px 0",lineHeight:1.2,maxWidth:"100%"}}>
            {!(bagniniNames||[]).includes(name) && name && <option value={name}>{name} (rimosso)</option>}
            {(bagniniNames||[]).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={S.pill}>2 / 2</div>
      </div>
      <div style={S.infoBox}>
        <span style={{fontSize:26}}>⏰</span>
        <div>
          <div style={S.infoTitle}>Indica i turni <em>preferiti</em></div>
          <div style={S.infoSub}>Un turno per giorno. Lun/Mar/Mer/Ven: 12–19 · Gio: 12–18 · Sab/Dom: 3 opzioni.</div>
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
        <div style={S.calTitle}>{m.name} 2026</div>
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
                <div key={ci} style={{flex:1,background:we?"#fffbea":"#fff",borderRadius:6,padding:"4px 2px",display:"flex",flexDirection:"column",alignItems:"center",gap:2,minWidth:0,border:`1px solid ${we?"#f5e070":"#e8e8e2"}`,boxShadow:"0 1px 3px #0000000a"}}>
                  <span style={{...S.cellNum,...(we?{color:"#c79500"}:{color:"#1a1a1a"})}}>{day}</span>
                  {dayShifts.map(s=>{
                    const on = selected===s.id;
                    return (
                      <button key={s.id} onClick={()=>toggleShift(day,s.id)} style={{
                        width:"100%",padding:"4px 2px",borderRadius:4,
                        border: on?`2px solid ${s.color}`:"2px solid #ddd",
                        background: on?s.color:"#f0f0ea",
                        color: on?s.text:"#444",
                        fontSize:10,fontWeight:800,cursor:"pointer",
                        fontFamily:"'Josefin Sans',sans-serif",lineHeight:1.4,textAlign:"center",
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
    <div style={{minHeight:"100vh",background:"#f5f5f0",fontFamily:"'Josefin Sans',sans-serif",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:32}}>
      <div style={{fontSize:60,marginBottom:16}}>🌊</div>
      <div style={{color:"#c79500",fontSize:10,letterSpacing:3,fontWeight:700,marginBottom:6}}>ASC HOTEL · PISCINA</div>
      <div style={{color:"#1a1a1a",fontSize:28,fontWeight:800,marginBottom:10}}>Grazie, {name}!</div>
      <div style={{color:"#888",fontSize:14,maxWidth:280,lineHeight:1.8,marginBottom:36}}>
        Le tue preferenze sono state salvate.<br/>Puoi rientrare in qualsiasi momento per modificarle.
      </div>
      <button onClick={onEdit} style={{background:"transparent",border:"2px solid #e0e0d8",color:"#888",fontSize:13,padding:"12px 28px",borderRadius:10,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",fontWeight:700}}>
        ← Torna al menu
      </button>
    </div>
  );
}

// ─── HUB (dopo login) ─────────────────────────────────────────────────────
function Hub({ name, onPrefs, onCheck, onMyShifts, onIngressi, onBack }) {
  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Ciao 👋</div>
          <div style={S.barName}>{name}</div>
        </div>
      </div>
      <div style={{padding:"22px 22px 28px",display:"flex",flexDirection:"column",gap:12,flex:1}}>
        <button onClick={onIngressi} style={{padding:"20px 18px",background:"#0891b2",color:"#fff",border:"none",borderRadius:14,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:14,textAlign:"left",boxShadow:"0 2px 8px #0000000d"}}>
          <span style={{fontSize:32}}>🏊</span>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:800}}>Ingressi Oggi</div>
            <div style={{fontSize:11,fontWeight:600,opacity:0.85,marginTop:2}}>Check-in delle prenotazioni coworking</div>
          </div>
          <span style={{fontSize:22}}>→</span>
        </button>
        <button onClick={onPrefs} style={{padding:"20px 18px",background:"#F5C200",color:"#1a1a1a",border:"none",borderRadius:14,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:14,textAlign:"left",boxShadow:"0 2px 8px #0000000d"}}>
          <span style={{fontSize:32}}>📝</span>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:800}}>Preferenze Turni</div>
            <div style={{fontSize:11,fontWeight:600,opacity:0.7,marginTop:2}}>Assenze e turni preferiti per l'estate 2026</div>
          </div>
          <span style={{fontSize:22}}>→</span>
        </button>
        <button onClick={onMyShifts} style={{padding:"20px 18px",background:"#2563eb",color:"#fff",border:"none",borderRadius:14,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:14,textAlign:"left",boxShadow:"0 2px 8px #0000000d"}}>
          <span style={{fontSize:32}}>📅</span>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:800}}>I miei turni</div>
            <div style={{fontSize:11,fontWeight:600,opacity:0.85,marginTop:2}}>Turni confermati, ore lavorate e richieste</div>
          </div>
          <span style={{fontSize:22}}>→</span>
        </button>
        <button onClick={onCheck} style={{padding:"20px 18px",background:"#16a34a",color:"#fff",border:"none",borderRadius:14,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:14,textAlign:"left",boxShadow:"0 2px 8px #0000000d"}}>
          <span style={{fontSize:32}}>✅</span>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:800}}>Checklist Giornaliera</div>
            <div style={{fontSize:11,fontWeight:600,opacity:0.85,marginTop:2}}>Task ingresso/uscita e azioni periodiche</div>
          </div>
          <span style={{fontSize:22}}>→</span>
        </button>
      </div>
    </div>
  );
}

// ─── I MIEI TURNI (bagnino) ───────────────────────────────────────────────
function EditHoursModal({ shift, onClose, onSubmitted }) {
  const [ore, setOre]       = useState(String(Number(shift.ore)));
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState("");

  const [, mm, dd] = shift.data.split("-").map(Number);
  const dow = getDow(mm, dd);
  const monthName = MONTHS.find(x => x.id === mm)?.name || "";
  const dowNames = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];

  async function submit() {
    const num = parseFloat(ore);
    if (isNaN(num) || num <= 0) { setError("Inserisci un numero di ore valido"); return; }
    if (!motivo.trim()) { setError("Il motivo è obbligatorio"); return; }
    setBusy(true); setError("");
    try {
      await roCreate({
        bagnino:        shift.bagnino,
        data:           shift.data,
        turno:          shift.turno,
        ore_confermate: Number(shift.ore),
        ore_richieste:  num,
        motivo:         motivo.trim(),
      });
      await onSubmitted();
    } catch (e) {
      setError(e.message || "Errore invio richiesta");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"#00000070",display:"flex",alignItems:"center",justifyContent:"center",zIndex:120,padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:380,width:"100%",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 8px 32px #00000035",padding:"20px",fontFamily:"'Josefin Sans',sans-serif"}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:14}}>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:"#c79500",fontWeight:800,letterSpacing:1.5}}>RICHIESTA MODIFICA ORE</div>
            <div style={{fontSize:18,fontWeight:800,color:"#1a1a1a",lineHeight:1.1,marginTop:2}}>✏️ {dowNames[dow]} {dd} {monthName}</div>
            <div style={{fontSize:11,color:"#888",marginTop:6,lineHeight:1.55}}>Turno {shiftLabel(dow, shift.turno)} · ore confermate: <strong>{Number(shift.ore)}h</strong></div>
          </div>
          <button onClick={onClose} disabled={busy} style={{background:"none",border:"none",fontSize:20,cursor:busy?"wait":"pointer",color:"#888",padding:"0 4px",lineHeight:1}}>✕</button>
        </div>

        <div style={{marginBottom:10}}>
          <div style={{fontSize:10,fontWeight:800,color:"#888",letterSpacing:1,marginBottom:5}}>ORE EFFETTIVE LAVORATE</div>
          <input type="number" step="0.5" min="0" max="24" value={ore} onChange={e=>{ setOre(e.target.value); setError(""); }} style={{width:"100%",padding:"10px 12px",border:"2px solid #e0e0d8",borderRadius:8,fontSize:16,fontFamily:"'Josefin Sans',sans-serif",outline:"none",color:"#1a1a1a",fontWeight:800,boxSizing:"border-box"}}/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:800,color:"#888",letterSpacing:1,marginBottom:5}}>MOTIVO <span style={{color:"#dc2626"}}>*</span></div>
          <textarea value={motivo} onChange={e=>{ setMotivo(e.target.value); setError(""); }} placeholder="Es. Sono rimasto fino alle 20 per emergenza…" rows={3} style={{width:"100%",padding:"10px 12px",border:"2px solid #e0e0d8",borderRadius:8,fontSize:13,fontFamily:"'Josefin Sans',sans-serif",outline:"none",color:"#1a1a1a",resize:"vertical",boxSizing:"border-box",lineHeight:1.5}}/>
        </div>
        {error && (
          <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:11,color:"#b91c1c"}}>{error}</div>
        )}
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} disabled={busy} style={{flex:1,padding:"11px",background:"#f0f0ea",border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#888",cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Annulla</button>
          <button onClick={submit} disabled={busy} style={{flex:1.6,padding:"11px",background:busy?"#aaa":"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
            {busy ? "Invio…" : "Invia richiesta"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MyShifts({ name, onBack }) {
  const [mi, setMi]               = useState(0);
  const [allShifts, setAllShifts] = useState([]); // TUTTI i turni_confermati
  const [requests, setRequests]   = useState([]); // solo le mie richieste
  const [loading, setLoading]     = useState(true);
  const [editShift, setEditShift] = useState(null);

  const m = MONTHS[mi];
  const monthPrefix = `${YEAR}-${pad2(m.id)}-`;
  const weeks = buildWeeks(m.id);
  const myColor = nameColor(name);
  const fmtN = n => Number.isInteger(n) ? `${n}` : n.toFixed(1).replace(/\.0$/,"");

  async function load() {
    setLoading(true);
    try {
      const [tcResp, ro] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/${TABLE_TC}?select=*&order=data.asc`, { headers: H }),
        roForBagnino(name),
      ]);
      const tc = tcResp.ok ? await tcResp.json() : [];
      setAllShifts(Array.isArray(tc) ? tc : []);
      setRequests(Array.isArray(ro) ? ro : []);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const monthShifts   = allShifts.filter(s => s.data.startsWith(monthPrefix));
  const myMonthShifts = monthShifts.filter(s => s.bagnino === name);
  const myTotalOre    = myMonthShifts.reduce((sum, s) => sum + Number(s.ore || 0), 0);

  // Latest request from `name` for this shift's (data,turno); null if none.
  function statusFor(shift) {
    if (shift.bagnino !== name) return { mine: false, kind: null, req: null };
    const req = requests
      .filter(r => r.data === shift.data && r.turno === shift.turno)
      .sort((a,b) => new Date(b.creata_il) - new Date(a.creata_il))[0];
    if (!req)                       return { mine: true, kind: "edit",     req: null };
    if (req.stato === "pending")    return { mine: true, kind: "pending",  req };
    if (req.stato === "approvata")  return { mine: true, kind: "approved", req };
    if (req.stato === "rifiutata")  return { mine: true, kind: "rejected", req };
    return { mine: true, kind: "edit", req: null };
  }

  function statusBadge(status) {
    const { kind, req } = status;
    if (kind === "edit")     return <span style={{fontSize:10,lineHeight:1}} title="Modifica ore">✏️</span>;
    if (kind === "pending")  return <span style={{fontSize:10,lineHeight:1}} title="Richiesta in attesa">⏳</span>;
    if (kind === "approved") return <span style={{fontSize:10,lineHeight:1,color:"#16a34a",fontWeight:800}} title="Richiesta approvata">✓</span>;
    if (kind === "rejected") return <span style={{fontSize:10,lineHeight:1,color:"#dc2626",fontWeight:800}} title={req?.nota_admin ? `Rifiutata: ${req.nota_admin}` : "Richiesta rifiutata"}>✗</span>;
    return null;
  }

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={S.barLabel}>I miei turni</div>
          <div style={S.barName}>{name}</div>
        </div>
      </div>

      <div style={{...S.tabs,marginTop:8}}>
        {MONTHS.map((mo,i)=>(
          <button key={mo.id} onClick={()=>setMi(i)} style={{...S.tab,...(i===mi?S.tabOn:{})}}>{mo.short}</button>
        ))}
      </div>

      {loading ? (
        <div style={{padding:"40px",textAlign:"center",color:"#888",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento turni…</div>
      ) : (
        <>
          {/* Calendar grid */}
          <div style={{padding:"6px 8px 14px"}}>
            <div style={{...S.calTitle,padding:"6px 10px 8px"}}>{m.name} {YEAR}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7, minmax(0,1fr))",gap:4,padding:"0 4px"}}>
              {WEEK_LABELS.map((l,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:9,fontWeight:800,color:i>=5?"#c79500":"#888",padding:"4px 0",letterSpacing:1}}>{l}</div>
              ))}
              {weeks.flat().map((day, idx) => {
                if (!day) return <div key={`e${idx}`}/>;
                const date     = dateStrOf(m.id, day);
                const dayRows  = monthShifts.filter(s => s.data === date);
                const dow      = getDow(m.id, day);
                const we       = isWE(m.id, day);
                const defs     = getShifts(dow);
                const hasMine  = dayRows.some(s => s.bagnino === name);
                return (
                  <div key={day} style={{
                    background:"#fff",
                    border: hasMine ? `2px solid ${myColor}` : `1px solid ${we ? "#f5e070" : "#e8e8e2"}`,
                    borderRadius:9,
                    padding:"5px 4px",
                    minHeight:100,minWidth:0,
                    display:"flex",flexDirection:"column",gap:2,
                    fontFamily:"'Josefin Sans',sans-serif",
                    boxShadow:"0 1px 3px #0000000a",
                  }}>
                    <div style={{fontSize:15,fontWeight:800,lineHeight:1,color:we?"#c79500":"#1a1a1a",marginBottom:1}}>{day}</div>
                    {defs.map(def => {
                      const inSlot = dayRows.filter(r => r.turno === def.id);
                      if (!inSlot.length) return null;
                      return (
                        <div key={def.id} style={{display:"flex",flexDirection:"column",gap:1,marginTop:1}}>
                          {/* Time chip (shift color) */}
                          <div style={{
                            background:def.color,color:def.text,
                            fontSize:7,fontWeight:800,padding:"1px 4px",
                            borderRadius:2,letterSpacing:0.2,alignSelf:"flex-start",lineHeight:1.3,
                          }}>{shiftLabel(dow, def.id)}</div>
                          {/* Bagnini chips */}
                          {inSlot.map(sh => {
                            const status     = statusFor(sh);
                            const mine       = status.mine;
                            const clickable  = mine && (status.kind === "edit" || status.kind === "rejected");
                            const inner = (
                              <>
                                <span style={{
                                  fontWeight: mine ? 800 : 600,
                                  color: mine ? "#1a1a1a" : "#777",
                                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                                  flex:1,minWidth:0,fontSize:8,lineHeight:1.3,
                                }}>{sh.bagnino.split(" ")[0]}·{fmtN(Number(sh.ore))}h</span>
                                {mine && statusBadge(status)}
                              </>
                            );
                            const baseStyle = {
                              display:"flex",alignItems:"center",gap:3,
                              padding: mine ? "1px 3px 1px 4px" : "1px 3px",
                              borderRadius:3,minWidth:0,
                              ...(mine ? {
                                background:`${myColor}22`,
                                borderLeft:`3px solid ${myColor}`,
                              } : {
                                opacity:0.5,
                                background:"#fafaf8",
                              }),
                            };
                            if (clickable) {
                              return (
                                <button key={sh.id} onClick={()=>setEditShift(sh)} style={{
                                  ...baseStyle,
                                  border:"none",cursor:"pointer",
                                  fontFamily:"inherit",textAlign:"left",width:"100%",
                                }}>{inner}</button>
                              );
                            }
                            return <div key={sh.id} style={baseStyle}>{inner}</div>;
                          })}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div style={{padding:"0 14px 28px",fontFamily:"'Josefin Sans',sans-serif"}}>
            {/* Personal totals */}
            <div style={{background:"#1a1a1a",borderRadius:12,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,boxShadow:"0 2px 8px #0000000d"}}>
              <div>
                <div style={{fontSize:10,color:myColor,fontWeight:800,letterSpacing:1.5}}>I TUOI TURNI</div>
                <div style={{fontSize:11,color:"#aaa",marginTop:2}}>{m.name} {YEAR}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:12,color:"#fff",fontWeight:700,letterSpacing:0.3}}>{myMonthShifts.length} turn{myMonthShifts.length===1?"o":"i"} · Totale</div>
                <div style={{fontSize:32,fontWeight:800,color:myColor,lineHeight:1,marginTop:2}}>{fmtN(myTotalOre)}h</div>
              </div>
            </div>

            {/* Legend */}
            <div style={{background:"#fff",border:"1px solid #e8e8e2",borderRadius:10,padding:"12px 14px",boxShadow:"0 1px 4px #0000000a"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",letterSpacing:1.5,marginBottom:8}}>LEGENDA</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:"6px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11}}>
                  <div style={{width:18,height:11,background:`${myColor}22`,borderLeft:`3px solid ${myColor}`,borderRadius:2,flexShrink:0}}/>
                  <span style={{color:"#1a1a1a",fontWeight:700}}>I tuoi turni</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11}}>
                  <div style={{width:18,height:11,background:"#fafaf8",border:"1px solid #ddd",borderRadius:2,opacity:0.55,flexShrink:0}}/>
                  <span style={{color:"#888",fontWeight:600}}>Altri bagnini</span>
                </div>
              </div>
              <div style={{marginTop:9,paddingTop:9,borderTop:"1px dashed #eee",display:"flex",flexWrap:"wrap",gap:"5px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10}}><span style={{fontSize:11}}>✏️</span><span style={{color:"#888"}}>modifica ore</span></div>
                <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10}}><span style={{fontSize:11}}>⏳</span><span style={{color:"#888"}}>in attesa</span></div>
                <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10}}><span style={{color:"#16a34a",fontWeight:800,fontSize:11}}>✓</span><span style={{color:"#888"}}>approvata</span></div>
                <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10}}><span style={{color:"#dc2626",fontWeight:800,fontSize:11}}>✗</span><span style={{color:"#888"}}>rifiutata</span></div>
              </div>
            </div>
          </div>
        </>
      )}

      {editShift && (
        <EditHoursModal
          shift={editShift}
          onClose={()=>setEditShift(null)}
          onSubmitted={async () => { setEditShift(null); await load(); }}
        />
      )}
    </div>
  );
}

// ─── INGRESSI OGGI (bagnino) ──────────────────────────────────────────────
function IngressiOggi({ name, onBack }) {
  const [bookings, setBookings] = useState([]);
  const [checkins, setCheckins] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [busyId, setBusyId]     = useState(null);
  const [error, setError]       = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [bs, ci] = await Promise.all([cwBookingsToday(), ciTodayCheckins()]);
      setBookings(Array.isArray(bs) ? bs : []);
      setCheckins(Array.isArray(ci) ? ci : []);
    } catch(e) {
      setError(e.message || "Errore caricamento dati");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function fullName(b) {
    if (!b.members) return "Membro sconosciuto";
    return `${b.members.name || ""} ${b.members.surname || ""}`.trim() || "—";
  }
  // Latest check-in for that member name today (by full name)
  function checkinFor(b) {
    const fn = fullName(b);
    return checkins
      .filter(c => c.nome_membro === fn)
      .sort((a,b) => new Date(b.ora_checkin) - new Date(a.ora_checkin))[0];
  }

  async function doCheckin(b) {
    if (busyId) return;
    const fn = fullName(b);
    if (!fn || fn === "—") return;
    setBusyId(b.id);
    try {
      await ciCheckin({ nome_membro: fn, bagnino_nome: name });
      await load();
    } catch(e) {
      window.alert(e.message || "Errore check-in");
    } finally {
      setBusyId(null);
    }
  }

  const todayLabel = new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  const checkedCount = bookings.filter(b => checkinFor(b)).length;

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={S.barLabel}>Ingressi Oggi</div>
          <div style={{...S.barName,textTransform:"capitalize"}}>{todayLabel}</div>
        </div>
        <button onClick={load} disabled={loading} title="Aggiorna" style={{...S.pill,cursor:loading?"wait":"pointer",background:"#1a1a1a",color:"#F5C200",fontSize:14,padding:"6px 12px"}}>🔄</button>
      </div>

      {/* Counter */}
      <div style={{padding:"10px 14px"}}>
        <div style={{background:"#1a1a1a",color:"#fff",borderRadius:12,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",fontFamily:"'Josefin Sans',sans-serif",boxShadow:"0 2px 8px #0000000d"}}>
          <div>
            <div style={{fontSize:10,color:"#F5C200",fontWeight:800,letterSpacing:1.5}}>PRENOTATI OGGI</div>
            <div style={{fontSize:11,color:"#aaa",marginTop:2}}>day-use coworking</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:30,fontWeight:800,color:"#22c55e",lineHeight:1}}>
              {checkedCount}<span style={{color:"#aaa",fontSize:18,marginLeft:4,fontWeight:700}}>/{bookings.length}</span>
            </div>
            <div style={{fontSize:10,color:"#aaa",marginTop:2,letterSpacing:0.5}}>entrati su totale</div>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{margin:"0 14px 10px",background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:10,padding:"10px 12px",fontSize:11,color:"#b91c1c",lineHeight:1.5,fontFamily:"'Josefin Sans',sans-serif"}}>
          ⚠ {error}
        </div>
      )}

      {/* List */}
      <div style={{padding:"0 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:8}}>
        {loading ? (
          <div style={{padding:"30px",textAlign:"center",color:"#888",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento prenotazioni…</div>
        ) : bookings.length === 0 ? (
          <div style={{padding:"30px",textAlign:"center",color:"#bbb",background:"#fff",borderRadius:12,border:"1px solid #e8e8e2",fontFamily:"'Josefin Sans',sans-serif"}}>
            Nessuna prenotazione per oggi
          </div>
        ) : bookings.map(b => {
          const fn = fullName(b);
          const ci = checkinFor(b);
          const isIn = !!ci;
          const bookedAt = new Date(b.created_at).toLocaleTimeString("it-IT", { hour:"2-digit", minute:"2-digit" });
          const inAt    = isIn ? new Date(ci.ora_checkin).toLocaleTimeString("it-IT", { hour:"2-digit", minute:"2-digit" }) : "";
          return (
            <div key={b.id} style={{
              background: isIn ? "#dcfce7" : "#fff",
              borderRadius: 12,
              border: `1px solid ${isIn ? "#86efac" : "#e8e8e2"}`,
              padding: "12px 14px",
              boxShadow: "0 1px 4px #0000000a",
              fontFamily: "'Josefin Sans',sans-serif",
            }}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:15,fontWeight:800,color:isIn?"#166534":"#1a1a1a",lineHeight:1.2}}>{fn}</div>
                  <div style={{fontSize:11,color:"#888",marginTop:3,fontWeight:600}}>Prenotato alle {bookedAt}</div>
                </div>
                {b.status === "confirmed" && (
                  <div style={{background:"#dbeafe",color:"#1d4ed8",border:"1px solid #93c5fd",fontSize:8,fontWeight:800,padding:"2px 7px",borderRadius:10,letterSpacing:0.3,whiteSpace:"nowrap"}}>CONFERMATA</div>
                )}
              </div>

              {isIn ? (
                <div style={{background:"#fff",border:"1px solid #86efac",borderRadius:6,padding:"7px 10px",fontSize:11,color:"#166534",fontWeight:700,lineHeight:1.5}}>
                  ✓ Entrato alle {inAt} da <strong>{ci.bagnino_nome}</strong>
                </div>
              ) : (
                <button onClick={()=>doCheckin(b)} disabled={busyId===b.id} style={{width:"100%",padding:"11px",background:busyId===b.id?"#aaa":"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:800,cursor:busyId===b.id?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.3}}>
                  {busyId===b.id ? "…" : "✓ Entrato"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── CHECKLIST (bagnino) ──────────────────────────────────────────────────
function Checklist({ name, onBack }) {
  const [tasks, setTasks]             = useState([]);
  const [completions, setCompletions] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState(null);

  async function load() {
    setLoading(true);
    const t = await ckTasks();
    setTasks(t);
    const dayComp     = await ckCompletionsByDate(todayISO());
    const nonDailyIds = t.filter(x => x.categoria==="PERIODICHE"||x.categoria==="OCCORRENZA").map(x=>x.id);
    const histComp    = nonDailyIds.length ? await ckCompletionsForTasks(nonDailyIds) : [];
    const seen = new Set(dayComp.map(c=>c.id));
    const all  = [...dayComp];
    histComp.forEach(c => { if(!seen.has(c.id)){ all.push(c); seen.add(c.id); } });
    setCompletions(all);
    setLoading(false);
  }
  useEffect(()=>{ load(); },[]);

  async function toggle(task) {
    if(busyId) return;
    const s = taskStatus(task, completions);
    // PERIODICHE entro la finestra di frequenza → non cliccabile per nessuno
    if (s && s._locked) return;
    // Completato da altri → no-op
    if (s && s.bagnino !== name) return;
    setBusyId(task.id);
    if (s) {
      await ckDeleteCompletion(s.id);
    } else {
      await ckComplete(task.id, name);
    }
    await load();
    setBusyId(null);
  }

  if(loading) return (
    <div style={{...S.page,alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#888",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento checklist…</div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={S.bar}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Checklist Giornaliera</div>
          <div style={S.barName}>{name}</div>
        </div>
        <div style={S.pill}>{new Date().toLocaleDateString("it-IT",{day:"2-digit",month:"short"})}</div>
      </div>

      <div style={{padding:"12px 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:14}}>
        {CK_CATS.map(cat => {
          const catTasks = tasks.filter(t => t.categoria === cat.id);
          const doneCnt  = catTasks.filter(t => taskStatus(t, completions)).length;
          return (
            <div key={cat.id} style={{background:"#fff",borderRadius:14,border:"1px solid #e8e8e2",overflow:"hidden",boxShadow:"0 1px 4px #0000000a"}}>
              <div style={{padding:"12px 14px",background:`${cat.color}15`,borderBottom:`2px solid ${cat.color}`,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:22}}>{cat.icon}</span>
                <div style={{flex:1}}>
                  <div style={{color:cat.color,fontSize:12,fontWeight:800,letterSpacing:1.2}}>{cat.label.toUpperCase()}</div>
                  <div style={{color:"#888",fontSize:10,fontWeight:600,marginTop:1}}>{cat.sublabel}</div>
                </div>
                <div style={{background:"#fff",color:cat.color,fontSize:11,fontWeight:800,padding:"3px 10px",borderRadius:20,border:`1px solid ${cat.color}40`}}>
                  {doneCnt}/{catTasks.length}
                </div>
              </div>
              <div>
                {catTasks.length===0 && (
                  <div style={{padding:"18px",color:"#bbb",fontSize:12,textAlign:"center"}}>Nessun task in questa categoria</div>
                )}
                {catTasks.map(t => {
                  const s          = taskStatus(t, completions);
                  const done       = !!s;
                  const mine       = done && s.bagnino === name;
                  const lockedBy   = done && !mine ? s.bagnino : null;
                  const freqLocked = !!(done && s._locked);
                  const interactive = !freqLocked && (!done || mine);
                  return (
                    <button key={t.id} onClick={()=>toggle(t)} disabled={busyId===t.id} style={{
                      display:"flex",alignItems:"center",gap:12,
                      width:"100%",padding:"12px 14px",
                      background: freqLocked ? "#f5f5f0" : (done ? "#f0fdf4" : "#fff"),
                      border:"none",
                      borderTop:"1px solid #f0f0ea",
                      cursor: busyId===t.id ? "wait" : (interactive ? "pointer" : "default"),
                      textAlign:"left",fontFamily:"'Josefin Sans',sans-serif",
                      opacity: busyId===t.id ? 0.6 : 1,
                    }}>
                      <div style={{
                        width:24,height:24,borderRadius:6,
                        border:`2px solid ${freqLocked ? "#bbb" : (done ? "#16a34a" : "#d0d0c8")}`,
                        background: freqLocked ? "#bbb" : (done ? "#16a34a" : "#fff"),
                        display:"flex",alignItems:"center",justifyContent:"center",
                        flexShrink:0,
                      }}>
                        {done && <span style={{color:"#fff",fontSize:14,fontWeight:800,lineHeight:1}}>✓</span>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{color: freqLocked ? "#888" : "#1a1a1a",fontSize:13,fontWeight:700,textDecoration:done?"line-through":"none",opacity:done?0.65:1,lineHeight:1.3}}>{t.titolo}</div>
                        {freqLocked ? (
                          <div style={{color:"#888",fontSize:10,fontWeight:600,marginTop:3,letterSpacing:0.2,lineHeight:1.45}}>
                            ✓ Fatto il {ddmm(s.completato_alle)} da {s.bagnino} · prossima volta: <span style={{color:"#9333ea",fontWeight:700}}>{ddmm(s._nextDue)}</span>
                          </div>
                        ) : done && (
                          <div style={{color:"#4ade80",fontSize:10,fontWeight:700,marginTop:3,letterSpacing:0.2,display:"flex",alignItems:"center",gap:4}}>
                            <span>✓ {s.bagnino} · {hhmm(s.completato_alle)}</span>
                            {lockedBy && <span style={{fontSize:9,color:"#aaa"}} title={`Solo ${lockedBy} può deselezionare`}>🔒</span>}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Local-state input for editing frequenza_giorni; saves on blur / Enter
function FreqInput({ task, onSave }) {
  const [val, setVal] = useState(task.frequenza_giorni ?? "");
  useEffect(()=>{ setVal(task.frequenza_giorni ?? ""); }, [task.frequenza_giorni]);
  return (
    <input
      type="number" min="1" max="365"
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => {
        const cur = String(task.frequenza_giorni ?? "");
        if (String(val) !== cur) onSave(task.id, val);
      }}
      onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
      placeholder="—"
      title="Numero di giorni dopo i quali il task torna 'da fare'"
      style={{width:46,padding:"4px 6px",border:"2px solid #e9d5ff",borderRadius:5,fontSize:11,textAlign:"center",fontFamily:"'Josefin Sans',sans-serif",outline:"none",color:"#9333ea",fontWeight:800,background:"#fff"}}
    />
  );
}

// ─── ADMIN CHECKLIST ──────────────────────────────────────────────────────
function AdminChecklist() {
  const [subTab, setSubTab]           = useState("storico");
  const [tasks, setTasks]             = useState([]);
  const [completions, setCompletions] = useState([]);
  const [date, setDate]               = useState(todayISO());
  const [loading, setLoading]         = useState(true);
  const [newTitle, setNewTitle]       = useState({ INGRESSO:"", USCITA:"", PERIODICHE:"", OCCORRENZA:"" });

  async function load() {
    setLoading(true);
    const t = await ckTasks();
    setTasks(t);
    const dayComp     = await ckCompletionsByDate(date);
    const nonDailyIds = t.filter(x => !["INGRESSO","USCITA"].includes(x.categoria)).map(x=>x.id);
    const histComp    = nonDailyIds.length ? await ckCompletionsForTasks(nonDailyIds) : [];
    const seen = new Set(dayComp.map(c=>c.id));
    const all  = [...dayComp];
    histComp.forEach(c => { if(!seen.has(c.id)){ all.push(c); seen.add(c.id); } });
    setCompletions(all);
    setLoading(false);
  }
  useEffect(()=>{ load(); /* eslint-disable-next-line */ },[date]);

  async function addTask(cat) {
    const title = newTitle[cat].trim();
    if(!title) return;
    const catTasks = tasks.filter(t => t.categoria===cat);
    const ord = catTasks.length ? Math.max(...catTasks.map(t => t.ordine||0)) + 10 : 10;
    await ckAddTask({ categoria: cat, titolo: title, ordine: ord });
    setNewTitle({...newTitle,[cat]:""});
    await load();
  }
  async function delTask(id, titolo) {
    if(!window.confirm(`Rimuovere il task "${titolo}"?\nVerrà nascosto dalla checklist; lo storico dei completamenti resta in archivio.`)) return;
    await ckDeleteTask(id);
    await load();
  }
  async function resetCat(cat) {
    if(!window.confirm(`Resettare la categoria ${cat}?\nVerranno CANCELLATI tutti i completamenti registrati per i task di questa categoria.`)) return;
    await ckResetCategory(cat);
    await load();
  }
  async function updateTaskFreq(id, raw) {
    const num = parseInt(raw, 10);
    const freq = (isNaN(num) || num <= 0) ? null : num;
    // Optimistic update so the input feels snappy
    setTasks(prev => prev.map(t => t.id === id ? {...t, frequenza_giorni: freq} : t));
    await ckUpdateTask(id, { frequenza_giorni: freq });
    await load();
  }

  const subTabBtn = (id, label) => (
    <button onClick={()=>setSubTab(id)} style={{
      flex:1,padding:"10px 8px",
      background: subTab===id ? "#1a1a1a":"#fff",
      color:      subTab===id ? "#F5C200":"#888",
      border:`2px solid ${subTab===id?"#1a1a1a":"#e0e0d8"}`,
      borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer",
      fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.5,
    }}>{label}</button>
  );

  if(loading) return (
    <div style={{padding:"24px",color:"#888",fontFamily:"'Josefin Sans',sans-serif",textAlign:"center"}}>Caricamento checklist…</div>
  );

  return (
    <div style={{padding:"8px 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",gap:6}}>
        {subTabBtn("storico", "📋 Storico")}
        {subTabBtn("gestione","⚙️ Gestione Task")}
      </div>

      {/* ============ STORICO ============ */}
      {subTab === "storico" && (
        <>
          <div style={{background:"#fff",borderRadius:12,padding:"12px 14px",border:"1px solid #e8e8e2",display:"flex",alignItems:"center",gap:10,boxShadow:"0 1px 4px #0000000a",flexWrap:"wrap"}}>
            <div style={{color:"#888",fontSize:10,fontWeight:800,letterSpacing:1.2,flex:1,minWidth:"100%",marginBottom:2}}>STORICO PER DATA (giornaliere)</div>
            <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{padding:"7px 10px",border:"2px solid #e0e0d8",borderRadius:8,fontFamily:"'Josefin Sans',sans-serif",fontSize:12,color:"#1a1a1a",outline:"none"}}/>
            <button onClick={()=>setDate(todayISO())} style={{padding:"7px 12px",background:"#f0f0ea",border:"none",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",color:"#888"}}>Oggi</button>
            <div style={{color:"#bbb",fontSize:10,marginLeft:"auto"}}>Le periodiche/occorrenza non dipendono dalla data</div>
          </div>

          {CK_CATS.map(cat => {
            const catTasks = tasks.filter(t => t.categoria === cat.id);
            return (
              <div key={cat.id} style={{background:"#fff",borderRadius:12,border:"1px solid #e8e8e2",overflow:"hidden",boxShadow:"0 1px 4px #0000000a"}}>
                <div style={{padding:"12px 14px",background:`${cat.color}15`,borderBottom:`2px solid ${cat.color}`,display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:20}}>{cat.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:cat.color,fontSize:12,fontWeight:800,letterSpacing:1.2}}>{cat.label.toUpperCase()}</div>
                    <div style={{color:"#888",fontSize:10}}>{cat.sublabel}</div>
                  </div>
                  <div style={{color:cat.color,fontSize:11,fontWeight:800,background:"#fff",padding:"3px 10px",borderRadius:20,border:`1px solid ${cat.color}40`}}>
                    {catTasks.filter(t=>taskStatus(t,completions,date)).length}/{catTasks.length}
                  </div>
                </div>
                <div>
                  {catTasks.length===0 && (
                    <div style={{padding:"14px",color:"#bbb",fontSize:11,textAlign:"center"}}>Nessun task</div>
                  )}
                  {catTasks.map(t => {
                    const s = taskStatus(t, completions, date);
                    const done = !!s;
                    return (
                      <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderTop:"1px solid #f0f0ea",background:done?"#f0fdf4":"#fff"}}>
                        <div style={{width:18,height:18,borderRadius:5,border:`2px solid ${done?"#16a34a":"#d0d0c8"}`,background:done?"#16a34a":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          {done && <span style={{color:"#fff",fontSize:11,fontWeight:800,lineHeight:1}}>✓</span>}
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{color:"#1a1a1a",fontSize:12,fontWeight:700,lineHeight:1.3}}>{t.titolo}</div>
                          {done ? (
                            <div style={{color: s._locked ? "#888" : "#16a34a",fontSize:10,fontWeight:700,marginTop:2}}>
                              {s.bagnino} · {dateLabel(s.completato_alle)}
                              {s._locked && (
                                <span style={{color:"#9333ea",fontStyle:"italic",fontWeight:700,marginLeft:6}}>· prossima: {ddmm(s._nextDue)}</span>
                              )}
                            </div>
                          ) : (
                            <div style={{color:"#bbb",fontSize:10,marginTop:2}}>— non completato</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* ============ GESTIONE TASK ============ */}
      {subTab === "gestione" && (
        <>
          {CK_CATS.map(cat => {
            const catTasks = tasks.filter(t => t.categoria === cat.id);
            return (
              <div key={cat.id} style={{background:"#fff",borderRadius:12,border:"1px solid #e8e8e2",overflow:"hidden",boxShadow:"0 1px 4px #0000000a"}}>
                <div style={{padding:"12px 14px",background:`${cat.color}15`,borderBottom:`2px solid ${cat.color}`,display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:20}}>{cat.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:cat.color,fontSize:12,fontWeight:800,letterSpacing:1.2}}>{cat.label.toUpperCase()}</div>
                    <div style={{color:"#888",fontSize:10}}>{cat.sublabel}</div>
                  </div>
                  {!cat.daily && (
                    <button onClick={()=>resetCat(cat.id)} title="Cancella tutti i completamenti di questa categoria" style={{padding:"6px 12px",background:cat.color,color:"#fff",border:"none",borderRadius:6,fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.5}}>
                      🔄 Reset
                    </button>
                  )}
                </div>

                <div>
                  {catTasks.length===0 && (
                    <div style={{padding:"14px",color:"#bbb",fontSize:11,textAlign:"center"}}>Nessun task</div>
                  )}
                  {catTasks.map(t => (
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderTop:"1px solid #f0f0ea",flexWrap:"wrap"}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:cat.color,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:120,color:"#1a1a1a",fontSize:12,fontWeight:700,lineHeight:1.3}}>{t.titolo}</div>
                      {cat.id === "PERIODICHE" && (
                        <div style={{display:"flex",alignItems:"center",gap:5,color:cat.color,fontSize:10,fontWeight:700,letterSpacing:0.3}}>
                          <span>ogni</span>
                          <FreqInput task={t} onSave={updateTaskFreq}/>
                          <span>giorni</span>
                        </div>
                      )}
                      <button onClick={()=>delTask(t.id,t.titolo)} style={{background:"none",border:"none",color:"#e63946",fontSize:15,cursor:"pointer",padding:"2px 6px",lineHeight:1}} title="Rimuovi task">✕</button>
                    </div>
                  ))}
                  <div style={{display:"flex",gap:6,padding:"10px 14px",borderTop:"1px solid #f0f0ea",background:"#fafaf8"}}>
                    <input
                      value={newTitle[cat.id]}
                      onChange={e=>setNewTitle({...newTitle,[cat.id]:e.target.value})}
                      onKeyDown={e=>e.key==="Enter"&&addTask(cat.id)}
                      placeholder="Nuovo task…"
                      style={{flex:1,padding:"8px 10px",border:"2px solid #e0e0d8",borderRadius:6,fontSize:12,fontFamily:"'Josefin Sans',sans-serif",outline:"none",minWidth:0}}
                    />
                    <button onClick={()=>addTask(cat.id)} style={{padding:"8px 14px",background:cat.color,color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",whiteSpace:"nowrap"}}>+ Aggiungi</button>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── ORE DI LAVORO ────────────────────────────────────────────────────────
// Renders the export-ready calendar at fixed 1200px. The outer <div> is the
// target of html2canvas. Same visual rules as the admin calendar but bigger.
function ExportCalendar({ innerRef, month, weeks, monthRows, staffNames }) {
  return (
    <div ref={innerRef} style={{
      width:1200,padding:"32px 32px 28px",background:"#f5f5f0",
      fontFamily:"'Josefin Sans',sans-serif",color:"#1a1a1a",
      boxSizing:"border-box",
    }}>
      {/* Header */}
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{color:"#c79500",fontSize:13,fontWeight:700,letterSpacing:5,textTransform:"uppercase",marginBottom:6}}>ASC Hotel · Piscina</div>
        <div style={{color:"#1a1a1a",fontSize:38,fontWeight:800,lineHeight:1}}>Turni {month.name} {YEAR}</div>
      </div>

      {/* Week labels */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7, 1fr)",gap:10,marginBottom:8}}>
        {WEEK_LABELS.map((l,i)=>(
          <div key={i} style={{textAlign:"center",fontSize:13,fontWeight:800,color:i>=5?"#c79500":"#888",padding:"8px 0",letterSpacing:1.8}}>{l}</div>
        ))}
      </div>

      {/* Cells */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7, 1fr)",gap:10}}>
        {weeks.flat().map((day,idx) => {
          if (!day) return <div key={`e${idx}`}/>;
          const rows = monthRows.filter(r => r.data === dateStrOf(month.id, day));
          const dow = getDow(month.id, day);
          const we  = isWE(month.id, day);
          const defs = getShifts(dow);
          const byTurno = {};
          rows.forEach(r => { (byTurno[r.turno] = byTurno[r.turno] || []).push(r); });
          return (
            <div key={day} style={{
              background: we ? "#fffbea" : "#fff",
              border: `2px solid ${we ? "#f5e070" : "#e8e8e2"}`,
              borderRadius: 14,
              padding: "12px 12px 10px",
              minHeight: 140,
              display: "flex", flexDirection: "column", gap: 6,
              boxShadow: "0 2px 4px #0000000a",
            }}>
              <div style={{fontSize:26,fontWeight:800,lineHeight:1,color:we?"#c79500":"#1a1a1a"}}>{day}</div>
              {defs.map(s => {
                const ppl = byTurno[s.id] || [];
                if (!ppl.length) return null;
                return (
                  <div key={s.id} style={{display:"flex",flexDirection:"column",gap:3,marginTop:2}}>
                    <div style={{fontSize:12,fontWeight:800,color:s.color,letterSpacing:0.3}}>{shiftLabel(dow, s.id)}</div>
                    {ppl.map(p => {
                      const c = nameColor(p.bagnino);
                      const first = p.bagnino.split(" ")[0];
                      return (
                        <div key={p.id} style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
                          <div style={{width:9,height:9,borderRadius:"50%",background:c,flexShrink:0}}/>
                          <div style={{fontSize:13,fontWeight:700,color:"#1a1a1a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{first}</div>
                          <div style={{fontSize:11,color:"#999",fontWeight:600}}>{Number(p.ore)}h</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Staff legend */}
      {staffNames.length > 0 && (
        <div style={{marginTop:24,padding:"18px 20px",background:"#fff",border:"1px solid #e8e8e2",borderRadius:14,boxShadow:"0 1px 4px #0000000a"}}>
          <div style={{fontSize:12,fontWeight:800,color:"#888",letterSpacing:1.8,marginBottom:14}}>STAFF</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:14}}>
            {staffNames.map(nome => {
              const c = nameColor(nome);
              return (
                <div key={nome} style={{display:"flex",alignItems:"center",gap:10,background:"#f9f9f6",padding:"7px 14px 7px 7px",borderRadius:24,border:"1px solid #eee"}}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:c,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,letterSpacing:0.5,boxShadow:"0 1px 3px #00000020"}}>{nameInitials(nome)}</div>
                  <div style={{fontSize:14,fontWeight:700,color:"#1a1a1a"}}>{nome}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Lazy-load a script tag and resolve once it executed
function loadScriptOnce(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${url}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = url;
    s.dataset.src = url;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
}

function ExportTurniModal({ confirmed, onClose }) {
  const [mi, setMi]               = useState(0);
  const [busy, setBusy]           = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const calRef = useRef(null);

  const m = MONTHS[mi];
  const weeks = buildWeeks(m.id);
  const monthPrefix = `${YEAR}-${pad2(m.id)}-`;
  const monthRows = confirmed.filter(c => c.data.startsWith(monthPrefix));
  const staffNames = [...new Set(monthRows.map(c => c.bagnino))]
    .sort((a,b) => a.localeCompare(b, "it"));
  const daysWithShifts = new Set(monthRows.map(c => c.data)).size;

  async function renderCanvas() {
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    if (!window.html2canvas) throw new Error("html2canvas non disponibile");
    if (!calRef.current) throw new Error("Anteprima non pronta");
    return await window.html2canvas(calRef.current, {
      backgroundColor: "#f5f5f0",
      scale: 1.5,        // crispness without huge files
      useCORS: true,
      logging: false,
    });
  }

  async function downloadJpg() {
    if (busy) return;
    setBusy(true); setBusyLabel("Generazione JPG…");
    try {
      const canvas = await renderCanvas();
      const link = document.createElement("a");
      link.download = `turni-${m.short.toLowerCase()}-${YEAR}.jpg`;
      link.href = canvas.toDataURL("image/jpeg", 0.92);
      link.click();
    } catch (e) {
      window.alert(`Errore esportazione JPG: ${e.message}`);
    } finally {
      setBusy(false); setBusyLabel("");
    }
  }

  async function downloadPdf() {
    if (busy) return;
    setBusy(true); setBusyLabel("Generazione PDF…");
    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
      const canvas = await renderCanvas();
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const JsPDFCtor = window.jspdf?.jsPDF;
      if (!JsPDFCtor) throw new Error("jsPDF non disponibile");
      // A4 landscape, fit canvas with margins
      const pdf = new JsPDFCtor({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const usableW = pageW - margin * 2;
      const usableH = pageH - margin * 2;
      const ratio = Math.min(usableW / canvas.width, usableH / canvas.height);
      const drawW = canvas.width  * ratio;
      const drawH = canvas.height * ratio;
      pdf.addImage(imgData, "JPEG", (pageW - drawW)/2, (pageH - drawH)/2, drawW, drawH);
      pdf.save(`turni-${m.short.toLowerCase()}-${YEAR}.pdf`);
    } catch (e) {
      window.alert(`Errore esportazione PDF: ${e.message}`);
    } finally {
      setBusy(false); setBusyLabel("");
    }
  }

  return (
    <div style={{position:"fixed",inset:0,background:"#00000070",display:"flex",alignItems:"center",justifyContent:"center",zIndex:120,padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:560,width:"100%",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 8px 32px #00000035",padding:"18px",fontFamily:"'Josefin Sans',sans-serif"}}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:14}}>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:"#c79500",fontWeight:800,letterSpacing:1.5}}>EXPORT</div>
            <div style={{fontSize:18,fontWeight:800,color:"#1a1a1a",lineHeight:1.1,marginTop:2}}>📤 Esporta turni confermati</div>
            <div style={{fontSize:11,color:"#888",marginTop:6,lineHeight:1.55}}>Scarica un'immagine o un PDF del calendario. Vengono inclusi <strong>solo i turni confermati</strong>; le preferenze non confermate non compaiono. Larghezza 1200px, ottimizzato per WhatsApp.</div>
          </div>
          <button onClick={onClose} disabled={busy} style={{background:"none",border:"none",fontSize:20,cursor:busy?"wait":"pointer",color:"#888",padding:"0 4px",lineHeight:1}}>✕</button>
        </div>

        <div style={{...S.tabs,marginBottom:10}}>
          {MONTHS.map((mo,i)=>(
            <button key={mo.id} onClick={()=>setMi(i)} disabled={busy} style={{...S.tab,...(i===mi?S.tabOn:{}),opacity:busy?0.5:1}}>{mo.short}</button>
          ))}
        </div>

        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <div style={{fontSize:11,color:"#888",fontWeight:700,letterSpacing:0.5}}>ANTEPRIMA</div>
          <div style={{fontSize:10,color:"#aaa"}}>{daysWithShifts} giorni con turni · {staffNames.length} bagnini</div>
        </div>

        {/* Preview: horizontal scroll on the rendered 1200px calendar.
            The same element is the html2canvas capture target. */}
        <div style={{maxWidth:"100%",overflow:"auto",border:"1px solid #e0e0d8",borderRadius:8,marginBottom:14,background:"#f5f5f0",maxHeight:360}}>
          <ExportCalendar
            innerRef={calRef}
            month={m}
            weeks={weeks}
            monthRows={monthRows}
            staffNames={staffNames}
          />
        </div>

        {monthRows.length === 0 && (
          <div style={{background:"#fef9c3",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:11,color:"#854d0e",lineHeight:1.55}}>
            ⚠ Nessun turno confermato per {m.name}. Verrà esportato un calendario vuoto — conferma prima i turni dal calendario admin.
          </div>
        )}

        {busy && (
          <div style={{background:"#dbeafe",border:"1px solid #93c5fd",borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:11,color:"#1d4ed8",fontWeight:700}}>⏳ {busyLabel}</div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} disabled={busy} style={{flex:1,padding:"11px",background:"#f0f0ea",border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#888",cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Chiudi</button>
          <button onClick={downloadJpg} disabled={busy} style={{flex:1.4,padding:"11px",background:busy?"#aaa":"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
            💾 Scarica JPG
          </button>
          <button onClick={downloadPdf} disabled={busy} style={{flex:1.4,padding:"11px",background:busy?"#aaa":"#dc2626",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
            📄 Scarica PDF
          </button>
        </div>
      </div>
    </div>
  );
}

function HoursCalendar({ data, confirmed, reload }) {
  const [mi, setMi]                 = useState(0);
  const [editDay, setEditDay]       = useState(null); // {monthId, day, dow, defs}
  const [editAssign, setEditAssign] = useState([]);   // [{bagnino,turno,ore}]
  const [saving, setSaving]         = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const m = MONTHS[mi];
  const weeks = buildWeeks(m.id);
  // Distinct, non-empty, alphabetically sorted bagnini names from bagnini_preferenze.
  // Used to populate every dropdown in the modal so admin can only pick existing
  // names (no free text → no typos / duplicates).
  const allNames = [...new Set(
    data.map(r => r.nome).filter(n => n && n.trim())
  )].sort((a,b) => a.localeCompare(b, "it"));

  function dayConfirmed(monthId, day) {
    return confirmed.filter(r => r.data === dateStrOf(monthId, day));
  }
  function dayPrefs(monthId, day) {
    const res = [];
    data.forEach(r => {
      if((r.absent?.[monthId]||[]).includes(day)) return;
      (r.shifts?.[monthId]?.[day]||[]).forEach(sid => res.push({ bagnino: r.nome, turno: sid }));
    });
    return res;
  }
  // Number of "extra" overlapping preferences for the day.
  // 2 bagnini sullo stesso turno → 1; 3 → 2; ecc. Sommato su tutti i turni.
  function dayPrefConflicts(monthId, day) {
    return countOverlaps(dayPrefs(monthId, day));
  }
  // Generic overlap counter: how many "extras" share the same `turno` field.
  function countOverlaps(items) {
    const counts = {};
    (items || []).forEach(a => { counts[a.turno] = (counts[a.turno]||0) + 1; });
    let extras = 0;
    Object.values(counts).forEach(n => { if(n > 1) extras += n - 1; });
    return extras;
  }
  function prefsForShift(monthId, day, sid) {
    return dayPrefs(monthId, day).filter(p => p.turno === sid);
  }
  // True if `nome` has expressed a preference for that exact turno on that day
  // (and is not absent on that day) in bagnini_preferenze.
  function bagninoHasPref(nome, monthId, day, turno) {
    const row = data.find(r => r.nome === nome);
    if (!row) return false;
    if ((row.absent?.[monthId] || []).includes(day)) return false;
    const sids = row.shifts?.[monthId]?.[day] || [];
    return sids.includes(turno);
  }

  function openEdit(day) {
    const monthId = m.id;
    const dow = getDow(monthId, day);
    const defs = getShifts(dow);
    const existing = dayConfirmed(monthId, day);
    if (existing.length) {
      setEditAssign(existing.map(r => ({ bagnino: r.bagnino, turno: r.turno, ore: Number(r.ore) })));
    } else {
      const prefs = dayPrefs(monthId, day);
      setEditAssign(prefs.map(p => ({ bagnino: p.bagnino, turno: p.turno, ore: shiftHours(dow, p.turno) })));
    }
    setEditDay({ monthId, day, dow, defs });
  }
  async function saveEdit() {
    if(!editDay) return;
    const clean = editAssign.filter(a => a.bagnino && a.bagnino.trim());
    setSaving(true);
    try {
      await tcReplaceForDay(dateStrOf(editDay.monthId, editDay.day), clean);
      await reload();
      setEditDay(null);
    } catch(e) {
      window.alert(`Errore di salvataggio: ${e.message}\n\nProbabile causa: RLS su turni_confermati non permette insert/delete all'anon key.\nVedi README o le istruzioni SQL.`);
    } finally {
      setSaving(false);
    }
  }
  async function clearDay() {
    if(!editDay) return;
    if(!window.confirm("Cancellare tutte le conferme di questo giorno?")) return;
    setSaving(true);
    try {
      await tcReplaceForDay(dateStrOf(editDay.monthId, editDay.day), []);
      await reload();
      setEditDay(null);
    } catch(e) {
      window.alert(`Errore: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }
  async function confirmMonthFromPrefs() {
    if(!window.confirm(
      `Confermare l'intero mese di ${m.name} dalle preferenze?\n\n` +
      `Verranno inseriti in turni_confermati TUTTI i bagnini che hanno espresso ` +
      `preferenza per ciascun turno (incluse le sovrapposizioni, da risolvere a mano). ` +
      `Le righe già esistenti NON vengono duplicate.`
    )) return;

    // Additive: skip ONLY exact (data, bagnino, turno) tuples that are already
    // in turni_confermati. Days with partial confirms get topped-up with the
    // missing preferences. This way "3 bagnini sullo stesso turno" produce 3
    // distinct rows even if one of them was already confirmed.
    const monthPrefix = `${YEAR}-${pad2(m.id)}-`;
    const existing = new Set(
      confirmed
        .filter(c => c.data.startsWith(monthPrefix))
        .map(c => `${c.data}|${c.bagnino}|${c.turno}`)
    );

    const rows = [];
    for(let day=1; day<=m.days; day++){
      const date = dateStrOf(m.id, day);
      const dow = getDow(m.id, day);
      dayPrefs(m.id, day).forEach(p => {
        const key = `${date}|${p.bagnino}|${p.turno}`;
        if (existing.has(key)) return;
        rows.push({
          data: date,
          bagnino: p.bagnino,
          turno: p.turno,
          ore: shiftHours(dow, p.turno),
        });
      });
    }
    if(!rows.length) { window.alert("Nessuna nuova preferenza da confermare in questo mese."); return; }
    try {
      await tcBulkInsert(rows);
      await reload();
      window.alert(`✓ Aggiunte ${rows.length} righe a turni_confermati. Le sovrapposizioni sono ora visibili nel calendario in arancione — clicca un giorno per scegliere chi tenere.`);
    } catch(e) {
      window.alert(`Errore: ${e.message}`);
    }
  }
  // Cancella da turni_confermati tutte le righe il cui (bagnino, data, turno)
  // non corrisponde a una preferenza in bagnini_preferenze.
  async function cleanupOrphans() {
    const orphans = confirmed.filter(r => {
      const [, mm, dd] = r.data.split("-").map(Number);
      return !bagninoHasPref(r.bagnino, mm, dd, r.turno);
    });
    if (orphans.length === 0) {
      window.alert("✓ Nessuna riga da ripulire — tutti i turni confermati hanno una preferenza corrispondente.");
      return;
    }
    if (!window.confirm(
      `Verranno eliminate ${orphans.length} righe da turni_confermati ` +
      `senza preferenza corrispondente in bagnini_preferenze.\n\n` +
      `Azione IRREVERSIBILE. Continuare?`
    )) return;
    const ids = orphans.map(r => r.id);
    const CHUNK = 80;
    let deleted = 0;
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await fetch(`${SB_URL}/rest/v1/${TABLE_TC}?id=in.(${chunk.join(",")})`, {
          method: "DELETE", headers: H,
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(()=>"")}`);
        deleted += chunk.length;
      }
      await reload();
      window.alert(`✓ Pulizia completata: ${deleted} righe eliminate da turni_confermati.`);
    } catch (e) {
      await reload();
      window.alert(`Pulizia interrotta dopo ${deleted} righe.\nErrore: ${e.message}`);
    }
  }

  function addAssign(turno) {
    const dow = editDay.dow;
    setEditAssign([...editAssign, { bagnino:"", turno, ore: shiftHours(dow, turno) }]);
  }
  function updateAssign(idx, patch) {
    setEditAssign(editAssign.map((a,i) => i===idx ? {...a,...patch} : a));
  }
  function removeAssign(idx) {
    setEditAssign(editAssign.filter((_,i)=>i!==idx));
  }
  // Wrapped onChange that warns when picking a bagnino without preference
  // for the row's turno on the current day.
  function pickAssignBagnino(idx, newName) {
    if (!editDay) return;
    const a = editAssign[idx];
    if (newName && !bagninoHasPref(newName, editDay.monthId, editDay.day, a.turno)) {
      const ok = window.confirm(
        `⚠️ ${newName} non ha espresso preferenza per questo turno — sei sicuro?\n\n` +
        `(OK = Aggiungi comunque · Annulla = Non aggiungere)`
      );
      if (!ok) return;
    }
    updateAssign(idx, { bagnino: newName });
  }

  const dowNames = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];

  return (
    <>
      <div style={{...S.tabs,marginTop:4}}>
        {MONTHS.map((mo,i)=>(
          <button key={mo.id} onClick={()=>setMi(i)} style={{...S.tab,...(i===mi?S.tabOn:{})}}>{mo.short}</button>
        ))}
      </div>

      <div style={{display:"flex",gap:10,alignItems:"center",padding:"8px 14px",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <div style={{width:10,height:10,background:"#dcfce7",borderRadius:2,border:"1px solid #86efac"}}/>
          <span style={{color:"#888",fontSize:10}}>Confermato</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <div style={{width:10,height:10,background:"#fef9c3",borderRadius:2,border:"1px solid #fde68a"}}/>
          <span style={{color:"#888",fontSize:10}}>Da preferenze</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <span style={{background:"#f97316",color:"#fff",fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:5,lineHeight:1.2}}>⚠️</span>
          <span style={{color:"#888",fontSize:10}}>Conflitto preferenze</span>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <button onClick={()=>setExportOpen(true)} title="Esporta il calendario dei turni confermati in JPG o PDF" style={{padding:"6px 10px",background:"#1a1a1a",color:"#F5C200",border:"none",borderRadius:6,fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.3,whiteSpace:"nowrap"}}>
            📤 Esporta turni
          </button>
          <button onClick={cleanupOrphans} title="Cancella da turni_confermati le righe senza preferenza corrispondente in bagnini_preferenze" style={{padding:"6px 10px",background:"#fff",color:"#666",border:"2px dashed #aaa",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.3,whiteSpace:"nowrap"}}>
            🧹 Ripulisci turni senza preferenza
          </button>
          <button onClick={confirmMonthFromPrefs} style={{padding:"6px 10px",background:"#16a34a",color:"#fff",border:"none",borderRadius:6,fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.3,whiteSpace:"nowrap"}}>
            ✓ Conferma mese da preferenze
          </button>
        </div>
      </div>

      {exportOpen && (
        <ExportTurniModal confirmed={confirmed} onClose={()=>setExportOpen(false)}/>
      )}

      <div style={{padding:"6px 8px 24px"}}>
        <div style={{...S.calTitle,padding:"4px 10px 8px"}}>{m.name} 2026</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7, minmax(0,1fr))",gap:4,padding:"0 4px"}}>
          {WEEK_LABELS.map((l,i)=>(
            <div key={i} style={{textAlign:"center",fontSize:9,fontWeight:800,color:i>=5?"#c79500":"#888",padding:"4px 0",letterSpacing:1}}>{l}</div>
          ))}
          {weeks.flat().map((day,idx)=>{
            if(!day) return <div key={`e${idx}`}/>;
            const conf = dayConfirmed(m.id, day);
            const isConf = conf.length > 0;
            const display = isConf ? conf.map(c=>({bagnino:c.bagnino,turno:c.turno,ore:Number(c.ore)}))
                                   : dayPrefs(m.id, day).map(p=>({bagnino:p.bagnino,turno:p.turno,ore:shiftHours(getDow(m.id,day),p.turno)}));
            const we = isWE(m.id, day);
            const conflicts = countOverlaps(display);    // overlaps in what's displayed
            const needsChoice = isConf && conflicts > 0; // confirmed AND overlapping = admin must resolve
            return (
              <button key={day} onClick={()=>openEdit(day)} style={{
                background: needsChoice ? "#fff7ed" : (isConf ? "#dcfce7" : (display.length ? "#fef9c3" : "#fff")),
                border:`1px solid ${needsChoice?"#fdba74":(isConf?"#86efac":(display.length?"#fde68a":(we?"#f5e070":"#e8e8e2")))}`,
                borderRadius:8,
                padding:"6px 4px",
                display:"flex",flexDirection:"column",gap:3,
                minHeight:88,minWidth:0,
                cursor:"pointer",
                fontFamily:"'Josefin Sans',sans-serif",
                textAlign:"left",
                boxShadow:"0 1px 3px #0000000a",
              }}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:3}}>
                  <div style={{fontSize:15,fontWeight:800,lineHeight:1,color:we?"#c79500":"#1a1a1a"}}>{day}</div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                    {conflicts > 0 && (
                      <div title={needsChoice ? `${conflicts} conferm${conflicts===1?"a":"e"} sullo stesso turno — scegli chi tenere` : `${conflicts} preferenz${conflicts===1?"a":"e"} sovrapposte`} style={{background:"#f97316",color:"#fff",fontSize:8,fontWeight:800,padding:"1px 4px",borderRadius:6,lineHeight:1.1,letterSpacing:0.2,whiteSpace:"nowrap"}}>
                        ⚠️ {conflicts}
                      </div>
                    )}
                    <div style={{fontSize:7,fontWeight:800,letterSpacing:0.3,color:isConf?"#166534":"#a16207",lineHeight:1}}>
                      {isConf ? `✓ ${display.length}` : (display.length ? `~ ${display.length}` : "—")}
                    </div>
                  </div>
                </div>
                <div style={{flex:1,display:"flex",flexDirection:"column",gap:1,minWidth:0}}>
                  {display.slice(0,4).map((a,i)=>(
                    <div key={i} style={{fontSize:8,lineHeight:1.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>
                      <span style={{fontWeight:800,color:isConf?"#166534":"#666"}}>{a.bagnino.split(" ")[0]}</span>
                      <span style={{color:"#999",marginLeft:2}}>·{a.ore}h</span>
                    </div>
                  ))}
                  {display.length>4 && <div style={{fontSize:7,color:"#aaa"}}>+{display.length-4}…</div>}
                  {needsChoice && (
                    <div style={{fontSize:8,color:"#c2410c",fontWeight:800,marginTop:2,letterSpacing:0.2,lineHeight:1.1}}>
                      ⚠ Devi scegliere
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* EDIT MODAL */}
      {editDay && (
        <div style={{position:"fixed",inset:0,background:"#00000070",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:14}}>
          <div style={{background:"#fff",borderRadius:14,maxWidth:420,width:"100%",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 8px 32px #00000035",padding:"18px",fontFamily:"'Josefin Sans',sans-serif"}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:9,color:"#c79500",fontWeight:800,letterSpacing:1.5}}>{MONTHS.find(x=>x.id===editDay.monthId).name.toUpperCase()} {YEAR}</div>
                <div style={{fontSize:22,fontWeight:800,color:"#1a1a1a",lineHeight:1.1,marginTop:2}}>Giorno {editDay.day}</div>
                <div style={{fontSize:11,color:"#888",marginTop:2}}>{dowNames[editDay.dow]} · turni: {editDay.defs.map(d=>shiftLabel(editDay.dow,d.id)).join(" / ")}</div>
              </div>
              <button onClick={()=>setEditDay(null)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#888",padding:"0 4px",lineHeight:1}}>✕</button>
            </div>

            {editDay.defs.map(s => {
              const prefs = prefsForShift(editDay.monthId, editDay.day, s.id);
              const assignedInSlot = editAssign.filter(a => a.turno === s.id && a.bagnino && a.bagnino.trim());
              const assignedNames  = new Set(assignedInSlot.map(a => a.bagnino));
              const available = prefs.filter(p => !assignedNames.has(p.bagnino));
              const prefOverlap     = prefs.length > 1;
              const assignedOverlap = assignedInSlot.length > 1; // ≥2 bagnini sullo stesso turno → l'admin DEVE risolvere
              return (
              <div key={s.id} style={{marginBottom:12,padding:"10px 12px",border:`1px solid ${assignedOverlap?"#f97316":(prefOverlap?"#fdba74":"#e8e8e2")}`,borderRadius:10,background:assignedOverlap?"#fff7ed":(prefOverlap?"#fffbeb":"#fafaf8"),borderWidth:assignedOverlap?2:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                  <div style={{background:s.color,color:s.text,padding:"3px 10px",borderRadius:14,fontSize:11,fontWeight:800,letterSpacing:0.3}}>{s.label}</div>
                  <div style={{color:"#888",fontSize:11,fontWeight:700}}>{shiftHours(editDay.dow,s.id)}h std</div>
                  {prefOverlap && (
                    <div style={{background:"#f97316",color:"#fff",fontSize:9,fontWeight:800,padding:"2px 7px",borderRadius:10,letterSpacing:0.3,marginLeft:"auto"}}>
                      ⚠️ {prefs.length} in preferenza
                    </div>
                  )}
                </div>
                {assignedOverlap && (
                  <div style={{background:"#f97316",color:"#fff",fontSize:11,fontWeight:800,padding:"7px 10px",borderRadius:8,letterSpacing:0.2,marginBottom:8,lineHeight:1.4}}>
                    ⚠️ Scegli chi tenere — rimuovi i bagnini in eccesso ({assignedInSlot.length} sullo stesso turno)
                  </div>
                )}
                {editAssign.map((a,i)=>{
                  if (a.turno !== s.id) return null;
                  return (
                    <div key={i} style={{display:"flex",gap:5,alignItems:"center",marginBottom:6}}>
                      <select value={a.bagnino} onChange={e=>pickAssignBagnino(i, e.target.value)} style={{flex:1,padding:"7px 8px",border:"2px solid #e0e0d8",borderRadius:6,fontSize:12,fontFamily:"'Josefin Sans',sans-serif",outline:"none",background:"#fff",color:"#1a1a1a",minWidth:0}}>
                        <option value="">— seleziona bagnino —</option>
                        {allNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <input type="number" step="0.5" min="0" value={a.ore} onChange={e=>updateAssign(i,{ore:Number(e.target.value)})} style={{width:54,padding:"7px 6px",border:"2px solid #e0e0d8",borderRadius:6,fontSize:12,fontFamily:"'Josefin Sans',sans-serif",outline:"none",textAlign:"center",color:"#1a1a1a"}}/>
                      <span style={{fontSize:11,color:"#888",fontWeight:700}}>h</span>
                      <button onClick={()=>removeAssign(i)} style={{background:"none",border:"none",color:"#e63946",cursor:"pointer",fontSize:14,padding:"4px 6px",lineHeight:1}} title="Rimuovi dalla conferma">✕</button>
                    </div>
                  );
                })}

                {/* Disponibili (preferenze non ancora confermate) */}
                {available.length > 0 && (
                  <div style={{marginTop:6,padding:"6px 4px 2px",fontSize:10,color:"#888",lineHeight:1.6}}>
                    <span style={{fontWeight:700,fontStyle:"normal",color:"#999",letterSpacing:0.3}}>Disponibili: </span>
                    {available.map((p, i) => (
                      <span key={p.bagnino}>
                        {i > 0 && <span style={{color:"#bbb"}}>, </span>}
                        <button
                          onClick={()=>setEditAssign(prev => [...prev, { bagnino: p.bagnino, turno: s.id, ore: shiftHours(editDay.dow, s.id) }])}
                          title="Aggiungi alle conferme"
                          style={{background:"none",border:"none",padding:"0 2px",color:"#2563eb",fontStyle:"italic",cursor:"pointer",fontFamily:"inherit",fontSize:"inherit",textDecoration:"underline",fontWeight:600}}
                        >
                          {p.bagnino}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {prefs.length === 0 && (
                  <div style={{marginTop:6,padding:"6px 4px 2px",fontSize:10,color:"#bbb",fontStyle:"italic"}}>
                    Nessuna preferenza espressa per questo turno
                  </div>
                )}

                <button onClick={()=>addAssign(s.id)} style={{background:"#fff",border:"1.5px dashed #ccc",borderRadius:6,padding:"6px 10px",fontSize:10,cursor:"pointer",color:"#888",fontFamily:"'Josefin Sans',sans-serif",fontWeight:700,width:"100%",marginTop:8,letterSpacing:0.3}}>
                  + Aggiungi altro bagnino (dal dropdown)
                </button>
              </div>
              );
            })}

            <div style={{display:"flex",gap:6,marginTop:14}}>
              <button onClick={clearDay} disabled={saving} style={{flex:1,padding:"10px 6px",background:"#fff",border:"2px solid #fca5a5",borderRadius:8,fontSize:10,fontWeight:800,color:"#e63946",cursor:saving?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.3}}>🗑️ Reset</button>
              <button onClick={()=>setEditDay(null)} disabled={saving} style={{flex:1,padding:"10px 6px",background:"#f0f0ea",border:"none",borderRadius:8,fontSize:11,fontWeight:700,color:"#888",cursor:saving?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Annulla</button>
              <button onClick={saveEdit} disabled={saving} style={{flex:1.6,padding:"10px 6px",background:saving?"#444":"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:saving?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>{saving?"…":"✓ Salva"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function HoursSummary({ data, confirmed }) {
  // For each bagnino × month: { conf, est }
  const rows = data.map(r => {
    const cells = MONTHS.map(mo => {
      const monthPrefix = `${YEAR}-${pad2(mo.id)}-`;
      const conf = confirmed
        .filter(c => c.bagnino === r.nome && c.data.startsWith(monthPrefix))
        .reduce((s,x) => s + Number(x.ore||0), 0);
      const confDates = new Set(
        confirmed.filter(c => c.data.startsWith(monthPrefix)).map(c => c.data)
      );
      let est = 0;
      for (let day = 1; day <= mo.days; day++) {
        if (confDates.has(dateStrOf(mo.id, day))) continue; // skip days already confirmed
        if ((r.absent?.[mo.id]||[]).includes(day)) continue;
        const sids = r.shifts?.[mo.id]?.[day] || [];
        const dow = getDow(mo.id, day);
        sids.forEach(sid => { est += shiftHours(dow, sid); });
      }
      return { conf, est };
    });
    const totConf = cells.reduce((s,c)=>s+c.conf,0);
    const totEst  = cells.reduce((s,c)=>s+c.est,0);
    return { nome: r.nome, cells, totConf, totEst };
  }).sort((a,b) => (b.totConf+b.totEst)-(a.totConf+a.totEst));

  const fmt = h => Number.isInteger(h) ? `${h}` : h.toFixed(1).replace(/\.0$/,"");

  return (
    <div style={{padding:"4px 10px 24px"}}>
      <div style={{background:"#fff",border:"1px solid #e8e8e2",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px #0000000a"}}>
        <div style={{padding:"12px 14px",borderBottom:"2px solid #16a34a",background:"#f0fdf4",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:20}}>📊</span>
          <div style={{flex:1}}>
            <div style={{color:"#166534",fontSize:12,fontWeight:800,letterSpacing:1.2}}>RIEPILOGO ORE</div>
            <div style={{color:"#888",fontSize:10}}>Estate 2026</div>
          </div>
        </div>

        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"'Josefin Sans',sans-serif",minWidth:480}}>
            <thead>
              <tr style={{background:"#fafaf8"}}>
                <th style={{textAlign:"left",padding:"10px 12px",fontSize:10,fontWeight:800,color:"#888",letterSpacing:1,borderBottom:"1px solid #e8e8e2"}}>BAGNINO</th>
                {MONTHS.map(mo => (
                  <th key={mo.id} style={{textAlign:"center",padding:"10px 6px",fontSize:10,fontWeight:800,color:"#888",letterSpacing:1,borderBottom:"1px solid #e8e8e2"}}>{mo.short}</th>
                ))}
                <th style={{textAlign:"center",padding:"10px 10px",fontSize:10,fontWeight:800,color:"#1a1a1a",letterSpacing:1,borderBottom:"1px solid #e8e8e2",background:"#fffbea"}}>TOT</th>
              </tr>
            </thead>
            <tbody>
              {rows.length===0 && (
                <tr><td colSpan={MONTHS.length+2} style={{padding:24,textAlign:"center",color:"#bbb",fontSize:12}}>Nessun bagnino registrato</td></tr>
              )}
              {rows.map(row => (
                <tr key={row.nome} style={{borderBottom:"1px solid #f0f0ea"}}>
                  <td style={{padding:"10px 12px",fontSize:12,fontWeight:700,color:"#1a1a1a",whiteSpace:"nowrap"}}>{row.nome}</td>
                  {row.cells.map((c,i)=>(
                    <td key={i} style={{padding:"8px 4px",textAlign:"center",verticalAlign:"middle"}}>
                      <div style={{color:c.conf>0?"#16a34a":"#ccc",fontSize:14,fontWeight:800,lineHeight:1}}>{fmt(c.conf)}h</div>
                      {c.est>0 && (
                        <div style={{color:"#999",fontSize:10,fontStyle:"italic",marginTop:2,lineHeight:1}}>+{fmt(c.est)}h</div>
                      )}
                    </td>
                  ))}
                  <td style={{padding:"8px 8px",textAlign:"center",background:"#fffbea",verticalAlign:"middle"}}>
                    <div style={{color:"#16a34a",fontSize:15,fontWeight:800,lineHeight:1}}>{fmt(row.totConf)}h</div>
                    {row.totEst>0 && (
                      <div style={{color:"#999",fontSize:10,fontStyle:"italic",marginTop:2,lineHeight:1}}>+{fmt(row.totEst)}h</div>
                    )}
                    <div style={{color:"#1a1a1a",fontSize:10,fontWeight:800,marginTop:4,paddingTop:3,borderTop:"1px dashed #e8e8e2"}}>={fmt(row.totConf+row.totEst)}h</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{padding:"10px 14px",background:"#fafaf8",borderTop:"1px solid #e8e8e2",fontSize:10,color:"#888",lineHeight:1.6}}>
          <span style={{color:"#16a34a",fontWeight:800}}>Verde</span> = ore confermate · <span style={{color:"#999",fontStyle:"italic"}}>Grigio +Xh</span> = ore stimate dalle preferenze (giorni non ancora confermati)
        </div>
      </div>
    </div>
  );
}

function Hours({ data }) {
  const [tab, setTab]           = useState("calendar");
  const [confirmed, setConfirmed] = useState([]);
  const [loading, setLoading]   = useState(true);

  async function reload() {
    setLoading(true);
    setConfirmed(await tcAll());
    setLoading(false);
  }
  useEffect(()=>{ reload(); },[]);

  return (
    <div style={{padding:"8px 0 24px",display:"flex",flexDirection:"column",gap:6,flex:1}}>
      <div style={{display:"flex",gap:6,padding:"0 14px"}}>
        <button onClick={()=>setTab("calendar")} style={{flex:1,padding:"10px 8px",background:tab==="calendar"?"#1a1a1a":"#fff",color:tab==="calendar"?"#F5C200":"#888",border:`2px solid ${tab==="calendar"?"#1a1a1a":"#e0e0d8"}`,borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.5}}>📅 Conferma turni</button>
        <button onClick={()=>setTab("summary")}  style={{flex:1,padding:"10px 8px",background:tab==="summary" ?"#1a1a1a":"#fff",color:tab==="summary" ?"#F5C200":"#888",border:`2px solid ${tab==="summary" ?"#1a1a1a":"#e0e0d8"}`,borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",letterSpacing:0.5}}>📊 Riepilogo ore</button>
      </div>
      {loading ? (
        <div style={{padding:30,textAlign:"center",color:"#888",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento…</div>
      ) : (
        tab==="calendar"
          ? <HoursCalendar data={data} confirmed={confirmed} reload={reload}/>
          : <HoursSummary  data={data} confirmed={confirmed}/>
      )}
    </div>
  );
}

// ─── ADMIN — RICHIESTE ORE ────────────────────────────────────────────────
function AdminRichieste({ onChange }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [actingId, setActingId] = useState(null);

  async function load() {
    setLoading(true);
    setRequests(await roAll());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const dowNames = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];
  const fmtN = n => Number.isInteger(Number(n)) ? `${Number(n)}` : Number(n).toFixed(1).replace(/\.0$/,"");
  function fmtDate(dataStr) {
    const [y,m,d] = dataStr.split("-").map(Number);
    const monthName = MONTHS.find(x => x.id === m)?.name || "";
    const dow = new Date(y, m-1, d).getDay();
    return `${dowNames[dow]} ${d} ${monthName}`;
  }

  async function approve(req) {
    const msg = `Approvare la richiesta di ${req.bagnino}?\n${fmtDate(req.data)} · turno ${req.turno}\n${fmtN(req.ore_confermate)}h → ${fmtN(req.ore_richieste)}h\n\nIl record in turni_confermati verrà aggiornato.`;
    if (!window.confirm(msg)) return;
    setActingId(req.id);
    try {
      await roApprove(req);
      await load();
      if (onChange) await onChange();
    } catch (e) {
      window.alert(`Errore approvazione: ${e.message}`);
    } finally {
      setActingId(null);
    }
  }
  async function reject(req) {
    const nota = window.prompt(`Rifiutare la richiesta di ${req.bagnino}?\n${fmtDate(req.data)} · turno ${req.turno}\n${fmtN(req.ore_confermate)}h → ${fmtN(req.ore_richieste)}h\n\nMotivo del rifiuto (opzionale, verrà mostrato al bagnino):`);
    if (nota === null) return;
    setActingId(req.id);
    try {
      await roReject(req.id, nota);
      await load();
      if (onChange) await onChange();
    } catch (e) {
      window.alert(`Errore rifiuto: ${e.message}`);
    } finally {
      setActingId(null);
    }
  }

  function reqCard(req, accent) {
    const [, mm, dd] = req.data.split("-").map(Number);
    const dow = getDow(mm, dd);
    const isPending = req.stato === "pending";
    const busy = actingId === req.id;
    return (
      <div key={req.id} style={{background:"#fff",borderRadius:10,border:`1px solid ${accent}`,padding:"12px 14px",boxShadow:"0 1px 4px #0000000a",fontFamily:"'Josefin Sans',sans-serif"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:800,color:"#1a1a1a"}}>{req.bagnino}</div>
            <div style={{fontSize:11,color:"#888",fontWeight:600,marginTop:2}}>{fmtDate(req.data)} · {shiftLabel(dow, req.turno)}</div>
          </div>
          <div style={{textAlign:"right",fontSize:13,fontWeight:800,whiteSpace:"nowrap"}}>
            <span style={{color:"#888"}}>{fmtN(req.ore_confermate)}h</span>
            <span style={{color:"#aaa",margin:"0 4px"}}>→</span>
            <span style={{color:"#1a1a1a"}}>{fmtN(req.ore_richieste)}h</span>
          </div>
        </div>
        <div style={{fontSize:11,color:"#555",background:"#fafaf8",border:"1px solid #eee",borderRadius:6,padding:"7px 10px",lineHeight:1.55,marginBottom:8,fontStyle:"italic"}}>
          "{req.motivo}"
        </div>
        {req.nota_admin && !isPending && (
          <div style={{fontSize:10,color:"#9333ea",fontWeight:700,marginBottom:8,letterSpacing:0.2}}>Nota admin: {req.nota_admin}</div>
        )}
        {isPending ? (
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>reject(req)} disabled={busy} style={{flex:1,padding:"9px",background:"#fff",border:"2px solid #fca5a5",borderRadius:6,fontSize:11,fontWeight:800,color:"#dc2626",cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>✗ Rifiuta</button>
            <button onClick={()=>approve(req)} disabled={busy} style={{flex:1,padding:"9px",background:"#16a34a",border:"none",borderRadius:6,fontSize:11,fontWeight:800,color:"#fff",cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>✓ Approva</button>
          </div>
        ) : (
          <div style={{fontSize:10,color:"#aaa",textAlign:"right",letterSpacing:0.2}}>
            gestita {req.gestita_il ? new Date(req.gestita_il).toLocaleString("it-IT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—"}
          </div>
        )}
      </div>
    );
  }

  const pending   = requests.filter(r => r.stato === "pending");
  const approvate = requests.filter(r => r.stato === "approvata");
  const rifiutate = requests.filter(r => r.stato === "rifiutata");

  if (loading) return (
    <div style={{padding:"24px",textAlign:"center",color:"#888",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento richieste…</div>
  );

  function group(title, color, list, emptyMsg) {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <div style={{fontSize:11,fontWeight:800,color:color,letterSpacing:1.5,marginBottom:2}}>{title} ({list.length})</div>
        {list.length === 0
          ? <div style={{padding:"14px",color:"#bbb",fontSize:11,textAlign:"center",background:"#fafaf8",border:"1px dashed #e0e0d8",borderRadius:8,fontFamily:"'Josefin Sans',sans-serif"}}>{emptyMsg}</div>
          : list.map(r => reqCard(r, color === "#a16207" ? "#fde68a" : (color === "#166534" ? "#86efac" : "#fca5a5")))}
      </div>
    );
  }

  return (
    <div style={{padding:"12px 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:18}}>
      {group("🟡 IN ATTESA",  "#a16207", pending,   "Nessuna richiesta da gestire")}
      {group("🟢 APPROVATE",  "#166534", approvate, "Nessuna richiesta approvata")}
      {group("🔴 RIFIUTATE",  "#b91c1c", rifiutate, "Nessuna richiesta rifiutata")}
    </div>
  );
}

// ─── MERGE DUPLICATE NAMES ────────────────────────────────────────────────
// JSONB merge helpers (used by the merge tool).
// absent: { "6": [1,2,3], "7": [5] } → union of days per month.
function mergeAbsent(a = {}, b = {}) {
  const out = { ...(a || {}) };
  Object.entries(b || {}).forEach(([mo, days]) => {
    const cur = new Set(out[mo] || []);
    (days || []).forEach(d => cur.add(d));
    out[mo] = [...cur].sort((x,y) => x - y);
  });
  return out;
}
// shifts: { "6": { "1": ["A"], "2": ["B"] } } → master keeps own day pref;
//         secondary fills in days the master left empty.
function mergeShifts(a = {}, b = {}) {
  const out = { ...(a || {}) };
  Object.entries(b || {}).forEach(([mo, dayMap]) => {
    const merged = { ...(out[mo] || {}) };
    Object.entries(dayMap || {}).forEach(([day, sids]) => {
      const existing = merged[day];
      if (!existing || existing.length === 0) merged[day] = sids;
    });
    out[mo] = merged;
  });
  return out;
}

// Runs the full merge across the 3 tables. Throws on critical failures
// (bagnini_preferenze patch/delete); the rename steps on turni_confermati
// and checklist_completamenti are best-effort (errors logged + reported).
async function mergeBagnini(master, secondary, allData) {
  if (!master || !secondary) throw new Error("Seleziona entrambi i nomi");
  if (master === secondary) throw new Error("Master e secondario sono lo stesso nome");

  const masterRow    = allData.find(r => r.nome === master);
  const secondaryRow = allData.find(r => r.nome === secondary);
  if (!masterRow)    throw new Error(`Master "${master}" non trovato`);
  if (!secondaryRow) throw new Error(`Secondario "${secondary}" non trovato`);

  const newAbsent = mergeAbsent(masterRow.absent || {}, secondaryRow.absent || {});
  const newShifts = mergeShifts(masterRow.shifts || {}, secondaryRow.shifts || {});

  // 1) Update master with merged jsonb
  await sbPatchRaw(master, { absent: newAbsent, shifts: newShifts });
  // 2) Delete secondary row
  await sbDeleteRow(secondary);

  // 3) Rename in turni_confermati (best-effort)
  let tcCount = 0, tcError = null;
  try {
    const rows = await tcRenameBagnino(secondary, master);
    tcCount = Array.isArray(rows) ? rows.length : 0;
  } catch (e) { tcError = e.message; console.error(e); }

  // 4) Rename in checklist_completamenti (best-effort)
  let ckCount = 0, ckError = null;
  try {
    const rows = await ckRenameBagnino(secondary, master);
    ckCount = Array.isArray(rows) ? rows.length : 0;
  } catch (e) { ckError = e.message; console.error(e); }

  return { tcCount, ckCount, tcError, ckError };
}

function MergeNamesModal({ data, onClose, onMerged }) {
  const [master, setMaster]       = useState("");
  const [secondary, setSecondary] = useState("");
  const [busy, setBusy]           = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState("");

  const names = [...new Set(
    (data || []).map(r => r.nome).filter(n => n && n.trim())
  )].sort((a,b) => a.localeCompare(b, "it"));

  async function doMerge() {
    if (!master || !secondary) { setError("Scegli entrambi i nomi"); return; }
    if (master === secondary)  { setError("Non puoi unire un nome con sé stesso"); return; }
    const msg = `Unire "${secondary}" dentro "${master}"?\n\n` +
                `• Trasferisce preferenze (absent + shifts) di "${secondary}" su "${master}"\n` +
                `• Cancella il record di "${secondary}" da bagnini_preferenze\n` +
                `• Rinomina tutte le righe di "${secondary}" in turni_confermati e checklist_completamenti\n\n` +
                `Azione IRREVERSIBILE.`;
    if (!window.confirm(msg)) return;

    setBusy(true);
    setError("");
    try {
      const res = await mergeBagnini(master, secondary, data);
      setResult({ master, secondary, ...res });
      if (onMerged) await onMerged();
    } catch (e) {
      setError(e.message || "Errore durante l'unione");
    } finally {
      setBusy(false);
    }
  }

  const selectStyle = {
    width:"100%",padding:"9px 10px",border:"2px solid #e0e0d8",borderRadius:8,
    fontSize:13,fontFamily:"'Josefin Sans',sans-serif",outline:"none",
    background:"#fff",color:"#1a1a1a",
  };

  return (
    <div style={{position:"fixed",inset:0,background:"#00000070",display:"flex",alignItems:"center",justifyContent:"center",zIndex:120,padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:440,width:"100%",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 8px 32px #00000035",padding:"20px",fontFamily:"'Josefin Sans',sans-serif"}}>

        {result ? (
          <div style={{textAlign:"center",padding:"4px 2px"}}>
            <div style={{fontSize:42,marginBottom:8}}>✅</div>
            <div style={{fontSize:18,fontWeight:800,color:"#16a34a",marginBottom:6}}>Unione completata</div>
            <div style={{fontSize:13,color:"#1a1a1a",marginBottom:14,lineHeight:1.5}}>
              <strong>{result.secondary}</strong> unito in <strong>{result.master}</strong>
            </div>
            <div style={{background:"#f9f9f6",border:"1px solid #e8e8e2",borderRadius:8,padding:"12px 14px",marginBottom:16,fontSize:11,color:"#555",textAlign:"left",lineHeight:1.85}}>
              <div>✓ Preferenze (assenze + turni) trasferite</div>
              <div>✓ Record "{result.secondary}" cancellato da bagnini_preferenze</div>
              <div>{result.tcError ? "⚠" : "✓"} {result.tcCount} righe rinominate in turni_confermati{result.tcError && <div style={{color:"#b91c1c",fontSize:10,fontStyle:"italic"}}>· {result.tcError}</div>}</div>
              <div>{result.ckError ? "⚠" : "✓"} {result.ckCount} righe rinominate in checklist_completamenti{result.ckError && <div style={{color:"#b91c1c",fontSize:10,fontStyle:"italic"}}>· {result.ckError}</div>}</div>
            </div>
            <button onClick={onClose} style={{padding:"11px 26px",background:"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Chiudi</button>
          </div>
        ) : (
          <>
            <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:14}}>
              <div style={{flex:1}}>
                <div style={{fontSize:9,color:"#c79500",fontWeight:800,letterSpacing:1.5}}>STRUMENTO ADMIN</div>
                <div style={{fontSize:18,fontWeight:800,color:"#1a1a1a",lineHeight:1.1,marginTop:2}}>🔀 Unisci nomi duplicati</div>
                <div style={{fontSize:11,color:"#888",marginTop:6,lineHeight:1.55}}>Trasferisce preferenze, turni confermati e completamenti checklist dal nome da eliminare al nome master. Il primo viene poi cancellato.</div>
              </div>
              <button onClick={onClose} disabled={busy} style={{background:"none",border:"none",fontSize:20,cursor:busy?"wait":"pointer",color:"#888",padding:"0 4px",lineHeight:1}}>✕</button>
            </div>

            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:800,color:"#e63946",letterSpacing:1,marginBottom:5}}>NOME DA ELIMINARE</div>
              <select value={secondary} onChange={e=>{ setSecondary(e.target.value); setError(""); }} style={selectStyle}>
                <option value="">— seleziona bagnino —</option>
                {names.filter(n => n !== master).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:800,color:"#16a34a",letterSpacing:1,marginBottom:5}}>NOME MASTER DA TENERE</div>
              <select value={master} onChange={e=>{ setMaster(e.target.value); setError(""); }} style={selectStyle}>
                <option value="">— seleziona bagnino —</option>
                {names.filter(n => n !== secondary).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            {master && secondary && master !== secondary && (
              <div style={{background:"#fef9c3",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:11,color:"#854d0e",lineHeight:1.55}}>
                ⚠ <strong>{secondary}</strong> verrà unito dentro <strong>{master}</strong> e poi eliminato.<br/>
                In caso di conflitto sulla stessa giornata, vincono le preferenze di <strong>{master}</strong>.
              </div>
            )}
            {error && (
              <div style={{background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 12px",marginBottom:12,fontSize:11,color:"#b91c1c",lineHeight:1.55}}>{error}</div>
            )}

            <div style={{display:"flex",gap:8,marginTop:6}}>
              <button onClick={onClose} disabled={busy} style={{flex:1,padding:"11px",background:"#f0f0ea",border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#888",cursor:busy?"wait":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Annulla</button>
              <button onClick={doMerge} disabled={busy || !master || !secondary || master===secondary} style={{flex:1.6,padding:"11px",background:(busy||!master||!secondary||master===secondary)?"#aaa":"#16a34a",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:800,cursor:(busy||!master||!secondary||master===secondary)?"not-allowed":"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
                {busy ? "Unione in corso…" : "✓ Conferma unione"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── ADMIN ────────────────────────────────────────────────────────────────
function Admin({ onBack }) {
  const [mi, setMi]       = useState(0);
  const [data, setData]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [copied, setCopied]   = useState(false);
  const [view, setView]       = useState("calendar");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [pendingReq, setPendingReq] = useState(0);

  async function reloadData() {
    const d = await sbAll();
    if (Array.isArray(d)) setData(d);
  }
  async function refreshPending() {
    setPendingReq(await roPendingCount());
  }

  useEffect(()=>{
    sbAll().then(d=>{
      if(Array.isArray(d)) { setData(d); }
      else { setLoadError(true); }
      setLoading(false);
    }).catch(()=>{ setLoadError(true); setLoading(false); });
    refreshPending();
  },[]);

  async function handleDelete(nome) {
    await fetch(`${SB_URL}/rest/v1/${TABLE}?nome=eq.${encodeURIComponent(nome)}`, {
      method: "DELETE", headers: H_ADMIN,
    });
    setData(data.filter(r=>r.nome!==nome));
    setConfirmDelete(null);
  }

  async function handleAddBagnino() {
    const raw = window.prompt("Nome e cognome del nuovo bagnino:");
    if (raw == null) return;
    const nome = raw.trim();
    if (!nome) return;
    if (data.some(r => r.nome.toLowerCase() === nome.toLowerCase())) {
      window.alert(`"${nome}" esiste già`);
      return;
    }
    try {
      const body = JSON.stringify({ nome, absent: {}, shifts: {}, aggiornato_il: new Date().toISOString() });
      const r = await fetch(`${SB_URL}/rest/v1/${TABLE}`, { method:"POST", headers: H_ADMIN, body });
      if(!r.ok) throw new Error(`${r.status} ${await r.text().catch(()=>"")}`);
      await reloadData();
    } catch (e) {
      window.alert(`Errore creazione bagnino: ${e.message}`);
    }
  }

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
    let txt = `# Preferenze Turni Bagnini — Estate 2026\n\n`;
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
    <div style={{...S.page,alignItems:"center",justifyContent:"center",gap:12}}>
      <div style={{color:"#F5C200",fontFamily:"'Josefin Sans',sans-serif"}}>Caricamento dati…</div>
    </div>
  );

  if(loadError) return (
    <div style={{...S.page,alignItems:"center",justifyContent:"center",gap:16,padding:24}}>
      <div style={{fontSize:40}}>⚠️</div>
      <div style={{color:"#1a1a1a",fontSize:16,fontWeight:800,fontFamily:"'Josefin Sans',sans-serif"}}>Errore di connessione</div>
      <div style={{color:"#888",fontSize:13,textAlign:"center",fontFamily:"'Josefin Sans',sans-serif",lineHeight:1.6}}>
        Non riesco a caricare i dati da Supabase.<br/>Controlla la console per i dettagli.
      </div>
      <button onClick={onBack} style={{...S.btnY,marginTop:8}}>← Torna indietro</button>
    </div>
  );

  return (
    <div style={{...S.page,background:"#f5f5f0"}}>
      <div style={{...S.bar,borderBottom:"3px solid #F5C200"}}>
        <button onClick={onBack} style={S.back}>←</button>
        <div style={{flex:1}}>
          <div style={S.barLabel}>Admin · ASC Hotel Piscina</div>
          <div style={S.barName}>Turni 2026</div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <button onClick={()=>setView("calendar")}  style={{...S.pill,cursor:"pointer",background:view==="calendar"?"#F5C200":"#f0f0ea",color:view==="calendar"?"#1a1a1a":"#aaa"}}>📅</button>
          <button onClick={()=>setView("checklist")} style={{...S.pill,cursor:"pointer",background:view==="checklist"?"#16a34a":"#f0f0ea",color:view==="checklist"?"#fff":"#aaa"}}>✓</button>
          <button onClick={()=>setView("hours")}     style={{...S.pill,cursor:"pointer",background:view==="hours"?"#1a1a1a":"#f0f0ea",color:view==="hours"?"#F5C200":"#aaa"}}>🕒</button>
          <div style={{position:"relative"}}>
            <button onClick={()=>setView("requests")} style={{...S.pill,cursor:"pointer",background:view==="requests"?"#dc2626":"#f0f0ea",color:view==="requests"?"#fff":"#aaa"}}>🔔</button>
            {pendingReq > 0 && (
              <span style={{position:"absolute",top:-5,right:-5,background:"#dc2626",color:"#fff",borderRadius:"50%",minWidth:18,height:18,padding:"0 4px",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",boxShadow:"0 1px 2px #00000033",letterSpacing:0}}>{pendingReq}</span>
            )}
          </div>
          <button onClick={()=>setView("export")}    style={{...S.pill,cursor:"pointer",background:view==="export"?"#2563eb":"#f0f0ea",color:view==="export"?"#fff":"#aaa"}}>AI</button>
        </div>
      </div>

      {/* Staff chips */}
      {view!=="checklist" && view!=="hours" && view!=="requests" && (
      <div style={{padding:"10px 14px",display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={handleAddBagnino} title="Crea un nuovo profilo bagnino vuoto" style={{background:"#16a34a",border:"none",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:11,fontWeight:800,color:"#fff",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",letterSpacing:0.3}}>
          + Nuovo bagnino
        </button>
        <button onClick={()=>setMergeOpen(true)} title="Unisci due nomi duplicati in uno" style={{background:"#fff",border:"2px dashed #aaa",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:11,fontWeight:700,color:"#666",fontFamily:"'Josefin Sans',sans-serif",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
          🔀 Unisci duplicati
        </button>
        {data.map(r=>{
          const tot = MONTHS.reduce((a,mo)=>{
            const wk = buildWeeks(mo.id).flat().filter(d=>d&&!(r.absent?.[mo.id]||[]).includes(d));
            return a+wk.filter(d=>(r.shifts?.[mo.id]?.[d]?.length||0)>0).length;
          },0);
          const upd = r.aggiornato_il ? new Date(r.aggiornato_il).toLocaleDateString("it-IT",{day:"2-digit",month:"2-digit"}) : "—";
          return (
            <div key={r.nome} style={{background:"#fff",border:"2px solid #F5C200",borderRadius:8,padding:"6px 10px",boxShadow:"0 1px 4px #0000000a",display:"flex",alignItems:"center",gap:8}}>
              <div>
                <div style={{color:"#1a1a1a",fontSize:12,fontWeight:700}}>{r.nome}</div>
                <div style={{color:"#aaa",fontSize:9}}>{tot} preferenze · agg. {upd}</div>
              </div>
              <button onClick={()=>setConfirmDelete(r.nome)} style={{background:"none",border:"none",cursor:"pointer",color:"#e63946",fontSize:14,padding:"2px 4px",lineHeight:1}} title="Elimina">✕</button>
            </div>
          );
        })}
        {data.length===0 && <div style={{color:"#ccc",fontSize:12}}>Nessun dato ancora</div>}
      </div>
      )}

      {/* Merge duplicate names modal */}
      {mergeOpen && (
        <MergeNamesModal
          data={data}
          onClose={()=>setMergeOpen(false)}
          onMerged={reloadData}
        />
      )}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div style={{position:"fixed",inset:0,background:"#00000060",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:24}}>
          <div style={{background:"#fff",borderRadius:14,padding:"28px 24px",maxWidth:320,width:"100%",boxShadow:"0 8px 32px #00000030",fontFamily:"'Josefin Sans',sans-serif"}}>
            <div style={{fontSize:32,textAlign:"center",marginBottom:12}}>🗑️</div>
            <div style={{color:"#1a1a1a",fontSize:15,fontWeight:800,textAlign:"center",marginBottom:8}}>Elimina bagnino</div>
            <div style={{color:"#888",fontSize:13,textAlign:"center",marginBottom:24,lineHeight:1.6}}>
              Vuoi eliminare tutti i dati di<br/><strong style={{color:"#1a1a1a"}}>{confirmDelete}</strong>?<br/>L'operazione non è reversibile.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmDelete(null)} style={{flex:1,padding:"11px",background:"#f0f0ea",border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",color:"#888"}}>
                Annulla
              </button>
              <button onClick={()=>handleDelete(confirmDelete)} style={{flex:1,padding:"11px",background:"#e63946",border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",color:"#fff"}}>
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CHECKLIST VIEW */}
      {view==="checklist" && <AdminChecklist/>}

      {/* HOURS VIEW */}
      {view==="hours" && <Hours data={data}/>}

      {/* REQUESTS VIEW */}
      {view==="requests" && <AdminRichieste onChange={refreshPending}/>}

      {/* EXPORT VIEW */}
      {view==="export" && (
        <div style={{padding:"12px 14px 32px",flex:1,display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#fff",border:"2px solid #16a34a",borderRadius:12,padding:"16px",boxShadow:"0 1px 4px #0000000a"}}>
            <div style={{color:"#16a34a",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:6}}>ANALISI AI CON CLAUDE</div>
            <div style={{color:"#888",fontSize:12,lineHeight:1.7,marginBottom:12}}>
              Copia il report qui sotto e incollalo in una nuova chat con Claude. Chiedi di creare i turni ottimali rispettando le preferenze e garantendo la copertura minima.
            </div>
            <button onClick={copyExport} style={{...S.btnY,background:copied?"#065f46":"#16a34a",color:"#fff",fontSize:13}}>
              {copied ? "✓ Copiato negli appunti!" : "📋 Copia report per Claude"}
            </button>
          </div>
          <div style={{background:"#f0f0ea",borderRadius:10,padding:"12px",fontFamily:"monospace",fontSize:10,color:"#888",maxHeight:400,overflowY:"auto",lineHeight:1.6,whiteSpace:"pre-wrap",border:"1px solid #e0e0d8"}}>
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
                ...S.tab,...(i===mi?S.tabOn:{}),
              }}>{mo.short}</button>
            ))}
          </div>

          <div style={{padding:"10px 8px 24px",flex:1}}>
            <div style={{...S.calTitle,padding:"6px 10px 10px"}}>{m.name} 2026</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7, minmax(0,1fr))",gap:6,padding:"0 6px"}}>
              {WEEK_LABELS.map((l,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,fontWeight:800,color:i>=5?"#c79500":"#888",padding:"6px 0",letterSpacing:1}}>{l}</div>
              ))}
              {weeks.flat().map((day,idx)=>{
                if(!day) return <div key={`e${idx}`}/>;
                const {byShift,off,defs,dow,total} = dayInfo(day);
                const we = isWE(m.id,day);
                const badge =
                  total===0 ? {bg:"#fee2e2",fg:"#b91c1c",label:"Scoperto",border:"#fca5a5"} :
                  total===1 ? {bg:"#fef9c3",fg:"#a16207",label:"1 bagnino",border:"#fde68a"} :
                              {bg:"#dcfce7",fg:"#166534",label:`${total} bagnini`,border:"#86efac"};
                return (
                  <div key={day} style={{
                    background:"#fff",
                    borderRadius:12,
                    border:`1px solid ${we?"#f5e070":"#e8e8e2"}`,
                    boxShadow:"0 1px 4px #0000000d",
                    padding:"10px 10px 8px",
                    display:"flex",flexDirection:"column",gap:6,
                    minHeight:120,minWidth:0,
                  }}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:6}}>
                      <div style={{fontSize:22,fontWeight:800,lineHeight:1,color:we?"#c79500":"#1a1a1a"}}>{day}</div>
                      <div style={{
                        background:badge.bg,color:badge.fg,
                        border:`1px solid ${badge.border}`,
                        fontSize:9,fontWeight:800,padding:"3px 7px",borderRadius:20,
                        whiteSpace:"nowrap",letterSpacing:0.3,
                      }}>{badge.label}</div>
                    </div>

                    <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:2}}>
                      {defs.map(s=>{
                        const ppl=byShift[s.id]||[];
                        if(!ppl.length) return null;
                        return (
                          <div key={s.id} style={{display:"flex",flexDirection:"column",gap:2}}>
                            <div style={{fontSize:9,fontWeight:800,color:s.color,letterSpacing:0.3}}>{shiftLabel(dow,s.id)}</div>
                            {ppl.map(p=>{
                              const c=nameColor(p);
                              return (
                                <div key={p} style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                                  <div style={{width:6,height:6,borderRadius:"50%",background:c,flexShrink:0}}/>
                                  <div style={{fontSize:11,fontWeight:700,color:"#1a1a1a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.split(" ")[0]}</div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                      {total===0 && (
                        <div style={{fontSize:10,fontStyle:"italic",color:"#bbb"}}>nessuno</div>
                      )}
                    </div>

                    {off.length>0 && (
                      <div style={{marginTop:"auto",paddingTop:6,borderTop:"1px dashed #eee"}}>
                        <div style={{fontSize:8,fontWeight:700,color:"#bbb",letterSpacing:0.5,marginBottom:2}}>ASSENTI</div>
                        <div style={{fontSize:10,color:"#999",lineHeight:1.4,overflow:"hidden",textOverflow:"ellipsis"}}>
                          {off.map(p=>p.split(" ")[0]).join(", ")}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Staff legend */}
            <div style={{marginTop:24,padding:"14px 14px 18px",background:"#fff",border:"1px solid #e8e8e2",borderRadius:12,boxShadow:"0 1px 4px #0000000a"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",letterSpacing:1.5,marginBottom:10}}>LEGENDA STAFF</div>
              {data.length===0 ? (
                <div style={{color:"#bbb",fontSize:12}}>Nessun bagnino registrato</div>
              ) : (
                <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
                  {data.map(r=>{
                    const c = nameColor(r.nome);
                    return (
                      <div key={r.nome} style={{display:"flex",alignItems:"center",gap:8,background:"#f9f9f6",padding:"6px 10px 6px 6px",borderRadius:20,border:"1px solid #eee"}}>
                        <div style={{
                          width:26,height:26,borderRadius:"50%",
                          background:c,color:"#fff",
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:10,fontWeight:800,letterSpacing:0.5,
                          boxShadow:"0 1px 3px #00000020",
                        }}>{nameInitials(r.nome)}</div>
                        <div style={{fontSize:12,fontWeight:700,color:"#1a1a1a"}}>{r.nome}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────
const S = {
  page:    {minHeight:"100vh",background:"#f5f5f0",fontFamily:"'Josefin Sans',sans-serif",display:"flex",flexDirection:"column"},
  bar:     {background:"#fff",padding:"14px 18px",display:"flex",alignItems:"center",gap:10,borderBottom:"3px solid #F5C200",boxShadow:"0 2px 8px #0000000a"},
  barLabel:{color:"#c79500",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"},
  barName: {color:"#1a1a1a",fontSize:19,fontWeight:800,lineHeight:1.1},
  pill:    {background:"#f0f0ea",color:"#888",fontSize:9,fontWeight:700,padding:"4px 10px",borderRadius:20,flexShrink:0,letterSpacing:1},
  back:    {background:"none",border:"none",color:"#1a1a1a",fontSize:22,cursor:"pointer",paddingRight:8},
  infoBox: {display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:"#fffbea",border:"1px solid #F5C200",margin:"10px 14px",borderRadius:12},
  infoTitle:{color:"#1a1a1a",fontSize:13,fontWeight:700,marginBottom:2},
  infoSub: {color:"#888",fontSize:11},
  tabs:    {display:"flex",gap:6,padding:"0 14px",overflowX:"auto"},
  tab:     {padding:"6px 14px",borderRadius:20,border:"2px solid #e0e0d8",background:"#fff",color:"#aaa",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif",whiteSpace:"nowrap",position:"relative",flexShrink:0},
  tabOn:   {border:"2px solid #F5C200",background:"#F5C200",color:"#1a1a1a"},
  badge:   {position:"absolute",top:-6,right:-6,borderRadius:"50%",width:15,height:15,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:"#fff"},
  cal:     {padding:"10px 8px 90px",flex:1},
  calTitle:{color:"#1a1a1a",fontSize:15,fontWeight:800,padding:"6px 8px 8px",letterSpacing:0.5},
  row:     {display:"flex",gap:2,marginBottom:2},
  hdr:     {flex:1,textAlign:"center",fontSize:8,fontWeight:800,color:"#aaa",padding:"4px 0",background:"#e8e8e2",borderRadius:3,letterSpacing:0.5},
  hdrWE:   {color:"#c79500"},
  cell:    {flex:1,aspectRatio:"1",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#fff",borderRadius:6,border:"2px solid #e8e8e2",cursor:"pointer",position:"relative",minHeight:36,gap:1,boxShadow:"0 1px 3px #0000000a"},
  cellWE:  {background:"#fffbea",border:"2px solid #f5e070"},
  cellOff: {background:"#fff0f0",border:"2px solid #fca5a5"},
  cellNum: {fontSize:16,fontWeight:800,color:"#1a1a1a",lineHeight:1},
  footer:  {position:"fixed",bottom:0,left:0,right:0,padding:"10px 14px",background:"#fff",borderTop:"1px solid #e8e8e2",display:"flex",flexDirection:"column",gap:6,boxShadow:"0 -2px 12px #0000000d"},
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
  const [bagniniNames, setBagniniNames]       = useState([]);
  const [bagniniLoading, setBagniniLoading]   = useState(true);
  const [bagniniLoadError, setBagniniLoadError] = useState(false);

  async function loadBagniniNames() {
    setBagniniLoading(true);
    try {
      const d = await sbAll();
      if(Array.isArray(d)) {
        const names = [...new Set(d.map(r => r.nome).filter(n => n && n.trim()))]
          .sort((a,b) => a.localeCompare(b, "it"));
        setBagniniNames(names);
        setBagniniLoadError(false);
      } else {
        setBagniniLoadError(true);
      }
    } catch (e) {
      console.error("loadBagniniNames", e);
      setBagniniLoadError(true);
    } finally {
      setBagniniLoading(false);
    }
  }

  useEffect(() => { loadBagniniNames(); }, []);
  // Refresh names whenever we land on the home/hub (admin may have just added/merged)
  useEffect(() => {
    if (screen === "home" || screen === "hub") loadBagniniNames();
  }, [screen]);

  // Switching name reloads that bagnino's saved preferences from Supabase.
  async function handleSelectName(newName) {
    setNameErr("");
    if (!newName) {
      setName(""); setAbsent({}); setShifts({});
      return;
    }
    setName(newName);
    const existing = await sbGet(newName);
    if (existing) { setAbsent(existing.absent || {}); setShifts(existing.shifts || {}); }
    else          { setAbsent({}); setShifts({}); }
  }

  function handleStart() {
    if(!name) { setNameErr("Seleziona il tuo nome dall'elenco"); return; }
    setNameErr("");
    setScreen("hub");
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

  if(screen==="hub")       return <Hub name={name.trim()} onPrefs={()=>setScreen("step1")} onCheck={()=>setScreen("checklist")} onMyShifts={()=>setScreen("myshifts")} onIngressi={()=>setScreen("ingressi")} onBack={()=>setScreen("home")}/>;
  if(screen==="checklist") return <Checklist name={name.trim()} onBack={()=>setScreen("hub")}/>;
  if(screen==="myshifts")  return <MyShifts  name={name.trim()} onBack={()=>setScreen("hub")}/>;
  if(screen==="ingressi")  return <IngressiOggi name={name.trim()} onBack={()=>setScreen("hub")}/>;
  if(screen==="step1")     return <StepAbsent name={name.trim()} absent={absent} setAbsent={setAbsent} onNext={()=>setScreen("step2")} bagniniNames={bagniniNames} onNameChange={handleSelectName}/>;
  if(screen==="step2")     return <StepShifts name={name.trim()} absent={absent} shifts={shifts} setShifts={setShifts} onBack={()=>setScreen("step1")} onSubmit={handleSubmit} saving={saving} bagniniNames={bagniniNames} onNameChange={handleSelectName}/>;
  if(screen==="done")      return <Done name={name.trim()} onEdit={()=>setScreen("hub")}/>;
  if(screen==="admin")     return <Admin onBack={()=>{ loadBagniniNames(); setScreen("home"); }}/>;

  if(screen==="adminLogin") return (
    <div style={{minHeight:"100vh",background:"#f5f5f0",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'Josefin Sans',sans-serif",padding:24}}>
      <div style={{color:"#c79500",fontSize:10,letterSpacing:3,fontWeight:700,marginBottom:6}}>AREA RISERVATA</div>
      <div style={{color:"#1a1a1a",fontSize:24,fontWeight:800,marginBottom:28}}>Admin · Piscina 2026</div>
      <input type="password" placeholder="Codice accesso" value={adminPw} onChange={e=>setAdminPw(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&tryAdmin()}
        style={{width:"100%",maxWidth:300,padding:"12px 16px",borderRadius:8,border:"2px solid #e0e0d8",background:"#fff",color:"#1a1a1a",fontSize:15,fontFamily:"'Josefin Sans',sans-serif",outline:"none",marginBottom:8,boxSizing:"border-box"}}/>
      {adminErr && <div style={{color:"#e63946",fontSize:12,marginBottom:8}}>{adminErr}</div>}
      <button onClick={tryAdmin} style={{width:"100%",maxWidth:300,padding:13,background:"#F5C200",color:"#1a1a1a",border:"none",borderRadius:8,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>Accedi</button>
      <button onClick={()=>setScreen("home")} style={{marginTop:14,background:"none",border:"none",color:"#aaa",cursor:"pointer",fontSize:12,fontFamily:"'Josefin Sans',sans-serif"}}>← Indietro</button>
    </div>
  );

  // HOME
  return (
    <div style={{minHeight:"100vh",background:"#f5f5f0",fontFamily:"'Josefin Sans',sans-serif",display:"flex",flexDirection:"column"}}>
      <div style={{background:"#1a1a1a",padding:"44px 26px 36px",borderBottom:"3px solid #F5C200"}}>
        <div style={{color:"#F5C200",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>ASC Hotel · Piscina</div>
        <div style={{color:"#fff",fontSize:38,fontWeight:800,lineHeight:1.0,marginBottom:8}}>Turni<br/>Estivi 2026</div>
        <div style={{color:"#888",fontSize:12,letterSpacing:1}}>GIU · LUG · AGO · SET</div>
      </div>
      <div style={{padding:"32px 22px",flex:1,display:"flex",flexDirection:"column",gap:18}}>
        <div>
          <div style={{color:"#888",fontSize:10,fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Seleziona il tuo nome</div>
          {bagniniLoading ? (
            <div style={{color:"#aaa",fontSize:13,padding:"14px 16px",border:"2px solid #e0e0d8",borderRadius:10,background:"#fff"}}>Caricamento…</div>
          ) : (bagniniLoadError || bagniniNames.length === 0) ? (
            <div style={{color:"#b91c1c",fontSize:13,padding:"14px 16px",border:"2px solid #fca5a5",borderRadius:10,background:"#fef2f2",lineHeight:1.55}}>
              ⚠ Nessun bagnino registrato — contatta l'admin per creare il tuo profilo.
            </div>
          ) : (
            <>
              <select
                value={name}
                onChange={e => handleSelectName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleStart()}
                style={{width:"100%",padding:"14px 16px",borderRadius:10,border:`2px solid ${nameErr?"#e63946":"#e0e0d8"}`,background:"#fff",color:name?"#1a1a1a":"#888",fontSize:16,fontFamily:"'Josefin Sans',sans-serif",outline:"none",boxSizing:"border-box",boxShadow:"0 1px 4px #0000000a",cursor:"pointer",fontWeight:name?700:400}}
              >
                <option value="">— Chi sei? —</option>
                {bagniniNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {nameErr && <div style={{color:"#e63946",fontSize:12,marginTop:5}}>{nameErr}</div>}
              <div style={{color:"#bbb",fontSize:11,marginTop:6}}>Solo i nomi registrati dall'admin sono selezionabili.</div>
            </>
          )}
        </div>
        <button onClick={handleStart} disabled={!name || bagniniLoading} style={{...S.btnY,fontSize:16,opacity:(!name||bagniniLoading)?0.5:1,cursor:(!name||bagniniLoading)?"not-allowed":"pointer"}}>Inizia →</button>
        <div style={{borderTop:"1px solid #e0e0d8",paddingTop:22}}>
          <button onClick={()=>setScreen("adminLogin")} style={{width:"100%",padding:12,background:"transparent",color:"#1a1a1a",border:"2px solid #e0e0d8",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"'Josefin Sans',sans-serif"}}>
            🔒 Area Admin
          </button>
        </div>
      </div>
    </div>
  );
}
