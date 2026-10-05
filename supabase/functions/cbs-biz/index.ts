// CBSystem Shop multi-tenant API. Deploy as an Edge Function named exactly: cbs-biz
// Settings: "Verify JWT with legacy secret" must be OFF. Secret required: ADMIN_KEY (30+ characters).
import { createClient } from 'npm:@supabase/supabase-js@2';

const T = 'cbs_shop_tenants';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ADMIN_KEY = Deno.env.get('ADMIN_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-key, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function sha256(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function newKey() {
  const c = [...rand(24)].map((b) => ALPHA[b % ALPHA.length]);
  return [0, 4, 8, 12, 16, 20].map((i) => c.slice(i, i + 4).join('')).join('-');
}
function pin(n: number) {
  let p = '';
  do { p = [...rand(n)].map((b) => b % 10).join(''); }
  while (/^(\d)\1+$/.test(p) || '01234567890'.includes(p) || '98765432109'.includes(p));
  return p;
}

// What a brand-new, empty shop starts with (no demo products).
function seed(name: string, pins: { owner: string; till: string; settings: string }) {
  return {
    staff: [
      { id: 'OWN', name: 'Owner', pin: pins.owner, role: 'manager', color: '#ffd700', emoji: '👑', active: true },
      { id: 'ST1', name: 'Till', pin: pins.till, role: 'staff', color: '#4a9eff', emoji: '🛒', active: true },
    ],
    products: [], stock: { loc1: {} }, locations: [{ id: 'loc1', name: 'Main Store' }],
    txns: [], movements: [], promotions: [], customers: [], idc: 0,
    cfg: { storeName: name, settingsPin: pins.settings, defaultLocation: 'loc1' },
  };
}

async function admin(req: Request, action: string, b: any) {
  const given = req.headers.get('x-admin-key') ?? '';
  if (ADMIN_KEY.length < 20 || !same(given, ADMIN_KEY)) { await sleep(500); return json({ error: 'Wrong admin key' }, 401); }

  if (action === 'admin_list') {
    const { data, error } = await sb.from(T).select('id,name,active,created_at,updated_at').order('created_at', { ascending: false });
    if (error) throw error;
    return json({ ok: true, businesses: data });
  }
  if (action === 'admin_create') {
    const name = String(b.name ?? '').trim().slice(0, 80);
    const id = String(b.id ?? '').trim().toLowerCase();
    if (!name || !ID_RE.test(id)) return json({ error: 'Enter a business name and an id (a-z, 0-9, dashes; 2-39 characters)' }, 400);
    const key = newKey();
    const pins = { owner: pin(6), till: pin(4), settings: pin(6) };
    const { error } = await sb.from(T).insert({ id, name, key_hash: await sha256(norm(key)), data: seed(name, pins) });
    if (error) return json({ error: error.code === '23505' ? 'That id is already taken' : 'Could not create the business' }, error.code === '23505' ? 409 : 500);
    return json({ ok: true, id, name, staffKey: key, ownerPin: pins.owner, tillPin: pins.till, settingsPin: pins.settings });
  }
  const id = String(b.id ?? '').toLowerCase();
  if (!ID_RE.test(id)) return json({ error: 'Bad id' }, 400);
  if (action === 'admin_setActive') {
    const { data, error } = await sb.from(T).update({ active: !!b.active }).eq('id', id).select('id');
    if (error) throw error;
    return json(data?.length ? { ok: true } : { error: 'Business not found' }, data?.length ? 200 : 404);
  }
  if (action === 'admin_resetKey') {
    const key = newKey();
    const { data, error } = await sb.from(T).update({ key_hash: await sha256(norm(key)) }).eq('id', id).select('id');
    if (error) throw error;
    return json(data?.length ? { ok: true, staffKey: key } : { error: 'Business not found' }, data?.length ? 200 : 404);
  }
  return json({ error: 'Unknown action' }, 400);
}

async function staff(action: string, b: any) {
  const id = String(b.biz ?? '').toLowerCase();
  const key = norm(String(b.key ?? ''));
  const bad = async () => { await sleep(500); return json({ error: 'Invalid business or key' }, 401); };
  if (!ID_RE.test(id) || !key) return bad();
  const { data: row } = await sb.from(T).select('name,key_hash,active,version').eq('id', id).maybeSingle();
  if (!row || !same(row.key_hash, await sha256(key))) return bad();
  if (!row.active) return json({ error: 'suspended' }, 403);

  if (action === 'pull') {
    if (b.since === row.version) return json({ ok: true, unchanged: true, version: row.version, name: row.name });
    const { data, error } = await sb.from(T).select('data,version').eq('id', id).single();
    if (error) throw error;
    return json({ ok: true, version: data.version, data: data.data, name: row.name });
  }
  if (action === 'push') {
    const base = Number(b.base);
    const d = b.data;
    if (!Number.isInteger(base) || !d || typeof d !== 'object' || !Array.isArray(d.staff) || !d.staff.length)
      return json({ error: 'Bad save request' }, 400);
    const { data: upd, error } = await sb.from(T)
      .update({ data: d, version: base + 1, updated_at: new Date().toISOString() })
      .eq('id', id).eq('version', base).select('version');
    if (error) throw error;
    if (!upd?.length) {
      const { data: cur } = await sb.from(T).select('data,version').eq('id', id).single();
      return json({ ok: false, conflict: true, version: cur!.version, data: cur!.data }, 409);
    }
    return json({ ok: true, version: upd[0].version });
  }
  return json({ error: 'Unknown action' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (Number(req.headers.get('content-length') ?? 0) > 9_000_000) return json({ error: 'Too large' }, 413);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const action = String(b?.action ?? '');
  try {
    return action.startsWith('admin_') ? await admin(req, action, b) : await staff(action, b);
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
