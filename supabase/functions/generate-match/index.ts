import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

if (!SUPABASE_URL || !SECRET_KEY || !CRON_SECRET) {
  throw new Error("Missing required environment variables");
}

const sb = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Player = {
  id: string;
  name: string;
  gender: "M" | "F";
  level: number;
  max_games: number | null;
  start_from: number;
};

type Match = {
  team1: Player[];
  team2: Player[];
  type: "mixed" | "men" | "women" | "junk";
};

type GridResult = {
  grid: (Match | null)[][];
  pCount: Record<string, number>;
  junkCount: number;
  historyPenalty: number;
  reusedPairs: number;
  reusedPartners: number;
  exactRepeats: number;
};

type History = {
  pair: Map<string, number>;
  partner: Map<string, number>;
  exact: Map<string, number>;
};

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}
function exactKey(ids: Array<string | Player>): string { return ids.map(x => typeof x === "string" ? x : x.id).sort().join("|"); }
function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }
function parseHHMM(s: string): number { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
function kstDateString(date = new Date()): string {
  const k = new Date(date.getTime() + 9 * 3600000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
}
function datePlusDays(s: string, days: number): string {
  const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function historyWeight(currentDate: string, pastDate: string): number {
  const diffDays = Math.max(0, Math.floor((new Date(`${currentDate}T00:00:00Z`).getTime() - new Date(`${pastDate}T00:00:00Z`).getTime()) / 86400000));
  const weeks = Math.floor(diffDays / 7);
  return Math.max(0.15, 1 / (1 + weeks));
}

function buildHistory(matches: any[]): History {
  const pair = new Map<string, number>(), partner = new Map<string, number>(), exact = new Map<string, number>();
  for (const m of matches) {
    const weight = Number(m._weight ?? 1);
    const t1: string[] = m.team1_ids ?? [], t2: string[] = m.team2_ids ?? [], all = [...t1, ...t2];
    if (all.length !== 4) continue;
    exact.set(exactKey(all), (exact.get(exactKey(all)) ?? 0) + weight);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const k = pairKey(all[i], all[j]); pair.set(k, (pair.get(k) ?? 0) + weight);
    }
    for (const team of [t1, t2]) if (team.length === 2) {
      const k = pairKey(team[0], team[1]); partner.set(k, (partner.get(k) ?? 0) + weight);
    }
  }
  return { pair, partner, exact };
}

function historyScore(team1: Player[], team2: Player[], history: History) {
  const all = [...team1, ...team2];
  let penalty = 0, reusedPairs = 0, reusedPartners = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const c = history.pair.get(pairKey(all[i].id, all[j].id)) ?? 0;
    if (c > 0) reusedPairs++;
    penalty += c * 3.5;
  }
  for (const team of [team1, team2]) {
    if (team.length === 2) {
      const c = history.partner.get(pairKey(team[0].id, team[1].id)) ?? 0;
      if (c > 0) reusedPartners++;
      penalty += c * 7;
    }
  }
  const exact = history.exact.get(exactKey(all)) ?? 0;
  penalty += exact * 24;
  return { penalty, reusedPairs, reusedPartners, exactRepeats: exact > 0 ? 1 : 0 };
}

function computePlan(m: number, f: number, T: number) {
  const needM = m >= 4, needF = f >= 4, canMix = m >= 2 && f >= 2;
  if (!canMix) {
    if (needM && needF) return { mixed: 0, men: Math.ceil(T / 2), women: Math.floor(T / 2) };
    return { mixed: 0, men: needM ? T : 0, women: needF ? T : 0 };
  }
  let best: any = null, bSc = Infinity;
  for (let n = needM ? 1 : 0; n <= (needM ? T : 0); n++) for (let w = needF ? 1 : 0; n + w <= T; w++) {
    const x = T - n - w;
    const sc = Math.abs((f > 0 ? (4 * w + 2 * x) / f : 0) - (m > 0 ? (4 * n + 2 * x) / m : 0)) * 10000 - x;
    if (sc < bSc) { bSc = sc; best = { mixed: x, men: n, women: w }; }
  }
  return best ?? { mixed: T, men: 0, women: 0 };
}

function makeSlotTypes(plan: any, T: number, CC: number) {
  const total = T * CC;
  const types = Array(total).fill("mixed");
  const sh = shuffle(Array.from({ length: total }, (_, i) => i));
  const mP = sh.filter(p => p < Math.ceil(total * 0.72));
  const wP = sh.filter(p => p >= Math.floor(total * 0.28) && types[p] === "mixed");
  for (let i = 0; i < plan.men && i < mP.length; i++) types[mP[i]] = "men";
  for (let i = 0; i < plan.women && i < wP.length; i++) types[wP[i]] = "women";
  return types;
}

function greedyFill(valid: Player[], slotTypes: string[], totalSlots: number, courtCount: number, capMap: Record<string, number>, history: History): GridResult {
  const pC: Record<string, number> = {}, mdC: Record<string, number> = {}, fdC: Record<string, number> = {}, rTB: Record<string, number> = {}, sfM: Record<string, number> = {};
  valid.forEach(p => { pC[p.id] = 0; mdC[p.id] = 0; fdC[p.id] = 0; rTB[p.id] = Math.random(); sfM[p.id] = Math.max(0, (p.start_from || 1) - 1); });
  const busy = Array.from({ length: totalSlots }, () => new Set<string>()), grid: (Match | null)[][] = Array.from({ length: totalSlots }, () => Array(courtCount).fill(null));
  const usedMK = new Set<string>(), pMap: Record<string, Set<string>> = {};
  valid.forEach(p => pMap[p.id] = new Set());
  let junk = 0, historyPenalty = 0, reusedPairs = 0, reusedPartners = 0, exactRepeats = 0;
  const cp = (p: Player, t: number, soft = false) => t >= sfM[p.id] && (soft || !capMap[p.id] || pC[p.id] < capMap[p.id]);
  const mk = (t1: Player[], t2: Player[]) => [t1.map(p => p.id).sort().join("-"), t2.map(p => p.id).sort().join("-")].sort().join("|");
  const score = (t1: Player[], t2: Player[], allowRepeat: boolean, gender?: "M" | "F") => {
    if (!allowRepeat && usedMK.has(mk(t1, t2))) return Infinity;
    const all = [...t1, ...t2], gm = Math.min(...valid.map(p => pC[p.id]));
    let s = all.reduce((x, p) => x + (pC[p.id] - gm) * 4, 0) + Math.abs(t1.reduce((x, p) => x + p.level, 0) - t2.reduce((x, p) => x + p.level, 0)) * 0.7;
    if (pMap[t1[0].id]?.has(t1[1].id)) s += 4;
    if (pMap[t2[0].id]?.has(t2[1].id)) s += 4;
    const hs = historyScore(t1, t2, history); s += hs.penalty;
    if (gender) {
      const tr = gender === "M" ? mdC : fdC, same = valid.filter(p => p.gender === gender);
      const tm = same.length ? Math.min(...same.map(p => tr[p.id])) : 0;
      s += all.reduce((x, p) => x + (tr[p.id] - tm) * 8, 0);
    }
    return s;
  };
  const fMix = (t: number, ar: boolean) => {
    const ms = valid.filter(p => !busy[t].has(p.id) && cp(p, t) && p.gender === "M").sort((a, b) => pC[a.id] - pC[b.id] || rTB[a.id] - rTB[b.id]);
    const fs = valid.filter(p => !busy[t].has(p.id) && cp(p, t) && p.gender === "F").sort((a, b) => pC[a.id] - pC[b.id] || rTB[a.id] - rTB[b.id]);
    if (ms.length < 2 || fs.length < 2) return null;
    let best: Match | null = null, bSc = Infinity;
    const mc = ms.slice(0, 8), fc = fs.slice(0, 8);
    for (let i = 0; i < mc.length; i++) for (let j = i + 1; j < mc.length; j++) for (let k = 0; k < fc.length; k++) for (let l = k + 1; l < fc.length; l++) {
      for (const [a, b] of [[[mc[i], fc[k]], [mc[j], fc[l]]], [[mc[i], fc[l]], [mc[j], fc[k]]]] as Player[][][]) {
        const sc = score(a, b, ar); if (sc < bSc) { bSc = sc; best = { team1: a, team2: b, type: "mixed" }; }
      }
    }
    return best;
  };
  const fSG = (t: number, g: "M" | "F", ar: boolean) => {
    const tr = g === "M" ? mdC : fdC;
    const pl = valid.filter(p => !busy[t].has(p.id) && cp(p, t) && p.gender === g).sort((a, b) => tr[a.id] - tr[b.id] || pC[a.id] - pC[b.id] || rTB[a.id] - rTB[b.id]);
    if (pl.length < 4) return null;
    const pc = pl.slice(0, 10); let best: Match | null = null, bSc = Infinity;
    for (let i = 0; i < pc.length; i++) for (let j = i + 1; j < pc.length; j++) for (let k = j + 1; k < pc.length; k++) for (let l = k + 1; l < pc.length; l++) {
      const f = [pc[i], pc[j], pc[k], pc[l]];
      for (const [a, b] of [[[f[0], f[1]], [f[2], f[3]]], [[f[0], f[2]], [f[1], f[3]]], [[f[0], f[3]], [f[1], f[2]]]] as Player[][][]) {
        const sc = score(a, b, ar, g); if (sc < bSc) { bSc = sc; best = { team1: a, team2: b, type: g === "M" ? "men" : "women" }; }
      }
    }
    return best;
  };
  const commit = (m: Match, t: number, c: number) => {
    grid[t][c] = m; usedMK.add(mk(m.team1, m.team2));
    const hs = historyScore(m.team1, m.team2, history); historyPenalty += hs.penalty; reusedPairs += hs.reusedPairs; reusedPartners += hs.reusedPartners; exactRepeats += hs.exactRepeats;
    [...m.team1, ...m.team2].forEach(p => { pC[p.id]++; busy[t].add(p.id); if (m.type === "men") mdC[p.id]++; if (m.type === "women") fdC[p.id]++; });
    for (const team of [m.team1, m.team2]) { pMap[team[0].id].add(team[1].id); pMap[team[1].id].add(team[0].id); }
    if (m.type === "junk") junk++;
  };
  for (let t = 0; t < totalSlots; t++) for (let c = 0; c < courtCount; c++) {
    const type = slotTypes[t * courtCount + c];
    let m: Match | null = null;
    if (type === "men") m = fSG(t, "M", false) ?? fMix(t, false) ?? fSG(t, "M", true) ?? fMix(t, true);
    else if (type === "women") m = fSG(t, "F", false) ?? fMix(t, false) ?? fSG(t, "F", true) ?? fMix(t, true);
    else { m = fMix(t, false) ?? fMix(t, true); if (!m) m = fSG(t, "M", true) ?? fSG(t, "F", true); }
    if (!m) {
      const all = valid.filter(p => !busy[t].has(p.id) && cp(p, t, true)).sort((a, b) => pC[a.id] - pC[b.id] || rTB[a.id] - rTB[b.id]);
      if (all.length >= 4) { const s = [...all].sort((a, b) => b.level - a.level); m = { team1: [s[0], s[3]], team2: [s[1], s[2]], type: "junk" }; }
    }
    if (m) commit(m, t, c);
  }
  return { grid, pCount: pC, junkCount: junk, historyPenalty, reusedPairs, reusedPartners, exactRepeats };
}

function buildSchedule(valid: Player[], c: { court_count: number; start_time: string; end_time: string; duration: number }, history: History) {
  const males = valid.filter(p => p.gender === "M"), females = valid.filter(p => p.gender === "F");
  const T = Math.floor((parseHHMM(c.end_time) - parseHHMM(c.start_time)) / c.duration), CC = c.court_count || 2;
  const plan = computePlan(males.length, females.length, T * CC), capMap: Record<string, number> = {};
  valid.forEach(p => { if (p.max_games) capMap[p.id] = p.max_games; });
  let best: GridResult | null = null, bSp = Infinity, bJk = Infinity, bHist = Infinity;
  for (let att = 0; att < 60; att++) {
    const v = shuffle(valid), st = makeSlotTypes(plan, T, CC), res = greedyFill(v, st, T, CC, capMap, history);
    const counts = v.map(p => res.pCount[p.id] || 0), mx = Math.max(...counts), mn = Math.min(...counts), spread = mx - mn;
    const better = !best || spread < bSp || (spread === bSp && res.junkCount < bJk) || (spread === bSp && res.junkCount === bJk && res.historyPenalty < bHist);
    if (better) { best = res; bSp = spread; bJk = res.junkCount; bHist = res.historyPenalty; }
    if (spread <= 1 && res.junkCount === 0 && res.exactRepeats === 0 && res.reusedPairs === 0) break;
  }
  if (!best) return null;
  const startMin = parseHHMM(c.start_time), labels = ["A코트", "B코트", "C코트", "D코트"];
  const courts = Array.from({ length: CC }, (_, ci) => ({
    label: labels[ci], matches: Array.from({ length: T }, (_, t) => ({
      time: startMin + t * c.duration,
      match: best!.grid[t][ci] ? { type: best!.grid[t][ci]!.type, team1: best!.grid[t][ci]!.team1.map(p => p.name), team2: best!.grid[t][ci]!.team2.map(p => p.name) } : null,
    })),
  }));
  const playerStats = valid.map(p => ({ name: p.name, gender: p.gender, level: p.level, games: best!.pCount[p.id] || 0 })).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  return {
    courts, plan, playerStats,
    verification: { max: Math.max(...valid.map(p => best!.pCount[p.id] || 0)), min: Math.min(...valid.map(p => best!.pCount[p.id] || 0)), spread: bSp, ok: bSp <= 1 },
    junkCount: best.junkCount, duration: c.duration,
    historyAvoidance: { reusedPairs: best.reusedPairs, reusedPartners: best.reusedPartners, exactRepeats: best.exactRepeats, weightedPenalty: Number(best.historyPenalty.toFixed(2)), historySessions: 12 },
    _grid: best.grid,
  };
}

async function isAdminRequest(req: Request) {
  const cron = req.headers.get("x-cron-secret");
  if (cron && cron === CRON_SECRET) return { ok: true, via: "cron" };
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return { ok: false, via: "none" };
  const token = auth.slice(7);
  const { data: userData } = await sb.auth.getUser(token);
  const user = userData.user;
  if (!user || user.is_anonymous) return { ok: false, via: "user" };
  const { data: admin } = await sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  return { ok: !!admin, via: "user" };
}

async function chooseSession(sessionId?: string, via = "user") {
  if (sessionId) {
    const { data, error } = await sb.from("sessions").select("*").eq("id", sessionId).single();
    if (error) throw error;
    return data;
  }
  const today = kstDateString();
  const { data, error } = await sb.from("sessions").select("*").eq("status", "open").lte("session_date", today).order("session_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("생성할 세션이 없습니다. 관리자가 세션을 먼저 만들어 주세요.");
  if (via === "cron" && data.session_date !== today) throw new Error(`오늘(${today}) 생성 대상 세션이 없습니다.`);
  return data;
}

async function main(req: Request) {
  const authz = await isAdminRequest(req);
  if (!authz.ok) return new Response(JSON.stringify({ error: "admin only" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const body = await req.json().catch(() => ({}));
  const session = await chooseSession(body.session_id, authz.via);
  if (session.status === "generated" && !body.force) return new Response(JSON.stringify({ message: "이미 생성된 세션입니다." }), { headers: { "Content-Type": "application/json" } });
  const { data: regs, error: rErr } = await sb.from("registrations").select("id,name,gender,level,max_games,start_from").eq("session_id", session.id).order("created_at", { ascending: true });
  if (rErr) throw rErr;
  if (!regs || regs.length < 4) throw new Error("최소 4명이 필요합니다.");
  const { data: pastSessions, error: psErr } = await sb.from("sessions").select("id,session_date").lt("session_date", session.session_date).order("session_date", { ascending: false }).limit(12);
  if (psErr) throw psErr;
  const ids = (pastSessions ?? []).map(s => s.id), dateMap: Record<string, string> = {};
  for (const s of pastSessions ?? []) dateMap[s.id] = s.session_date;
  let historyMatches: any[] = [];
  if (ids.length) {
    const { data, error } = await sb.from("matches").select("session_id,team1_ids,team2_ids").in("session_id", ids);
    if (error) throw error;
    historyMatches = (data ?? []).map(m => ({ ...m, _weight: historyWeight(session.session_date, dateMap[m.session_id]) }));
  }
  const history = buildHistory(historyMatches);
  const players: Player[] = regs.map((r: any) => ({ id: r.id, name: r.name, gender: r.gender, level: r.level, max_games: r.max_games, start_from: r.start_from }));
  const result = buildSchedule(players, session, history);
  if (!result) throw new Error("대진표 생성 실패");
  const generatedAt = new Date().toISOString();

  // current schedule replace; past sessions remain untouched.
  const { data: oldSchedule } = await sb.from("schedules").select("id").eq("session_id", session.id).maybeSingle();
  if (oldSchedule) await sb.from("schedules").delete().eq("id", oldSchedule.id);
  const { data: scheduleRow, error: sErr } = await sb.from("schedules").insert({ session_id: session.id, generated_at: generatedAt, duration: result.duration, plan: result.plan, verification: result.verification, junk_count: result.junkCount, history_avoidance: result.historyAvoidance, player_stats: result.playerStats, courts: result.courts }).select("id").single();
  if (sErr) throw sErr;

  const matchRows: any[] = [];
  for (let t = 0; t < result._grid.length; t++) for (let c = 0; c < result._grid[t].length; c++) {
    const m = result._grid[t][c]; if (!m) continue;
    matchRows.push({ schedule_id: scheduleRow.id, session_id: session.id, court_no: c + 1, slot_no: t + 1, start_minute: parseHHMM(session.start_time) + t * session.duration, match_type: m.type, team1_ids: m.team1.map(p => p.id), team2_ids: m.team2.map(p => p.id), player_ids: [...m.team1, ...m.team2].map(p => p.id), team1_names: m.team1.map(p => p.name), team2_names: m.team2.map(p => p.name) });
  }
  if (matchRows.length) { const { error } = await sb.from("matches").insert(matchRows); if (error) throw error; }
  const { error: upErr } = await sb.from("sessions").update({ status: "generated", generated_at: generatedAt }).eq("id", session.id); if (upErr) throw upErr;

  // Generate the next Saturday session automatically, so weekly operation does not need a manual step.
  const next = datePlusDays(session.session_date, 7);
  await sb.from("sessions").upsert({ session_date: next, status: "open", court_count: session.court_count, start_time: session.start_time, end_time: session.end_time, duration: session.duration }, { onConflict: "session_date", ignoreDuplicates: true });

  return { message: `${session.session_date} 대진표 생성 완료`, session_id: session.id, generated_at: generatedAt, history: result.historyAvoidance, next_session_date: next };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const result = await main(req);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
});
