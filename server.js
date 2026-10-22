import http from 'node:http';
import pg from 'pg';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://vitrano-storefront.onrender.com';
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;
const RATE_WINDOW_MS = 60_000, RATE_MAX = 12, requests = new Map();

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin'
  });
  res.end(JSON.stringify(body));
};
function rateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown', now = Date.now();
  const recent = (requests.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now); requests.set(key, recent);
  return recent.length > RATE_MAX;
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 40000) { const e = new Error('Request body too large'); e.status = 413; throw e; }
  }
  try { return JSON.parse(raw || '{}'); }
  catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}
const clean = v => typeof v === 'string' ? v.trim() : '';
const safeString = (v, max = 160) => clean(v).slice(0, max);
const validPhone = v => /^[+\d()\s-]{9,20}$/.test(v);
const requireDb = () => { if (!pool) { const e = new Error('Database not configured'); e.status = 503; throw e; } };

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin is not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'Origin' });
    return res.end();
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let databaseConnected = false;
      if (pool) { try { await pool.query('select 1'); databaseConnected = true; } catch {} }
      return json(res, 200, { ok: true, service: 'vitrano-api', databaseConfigured: Boolean(pool), databaseConnected });
    }
    if (req.method === 'GET' && url.pathname === '/api/categories') {
      requireDb();
      const { rows } = await pool.query('select id,name,slug,sort_order from categories where is_visible=true order by sort_order,name');
      return json(res, 200, { categories: rows });
    }
    if (req.method === 'GET' && url.pathname === '/api/products') {
      requireDb();
      const q = safeString(url.searchParams.get('q'), 80);
      const category = safeString(url.searchParams.get('category'), 80);
      const params = [], filters = ['p.is_visible=true'];
      if (q) { params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); filters.push(`(p.name ilike $1 escape '\\\\' or coalesce(p.description,'') ilike $1 escape '\\\\')`); }
      if (category) { params.push(category); filters.push(`c.slug=$${params.length}`); }
      const { rows } = await pool.query(`
        select p.id,p.sku,p.name,p.slug,p.description,p.characteristics,p.category_id,p.image_urls,p.main_image_url,
          case when c.id is null then null else json_build_object('name',c.name,'slug',c.slug) end as category,
          coalesce(json_agg(json_build_object('id',o.id,'supplier_id',o.supplier_id,'supplier_name',s.name,'retail_price',o.retail_price,'availability',o.availability,'last_checked_at',o.last_checked_at))
            filter (where o.id is not null and o.retail_price is not null), '[]'::json) as offers
        from products p left join categories c on c.id=p.category_id
        left join supplier_offers o on o.product_id=p.id and o.is_active=true
        left join suppliers s on s.id=o.supplier_id and s.is_active=true
        where ${filters.join(' and ')}
        group by p.id,c.id order by p.name asc limit 100`, params);
      return json(res, 200, { products: rows.filter(p => p.offers.length > 0) });
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      if (rateLimited(req)) return json(res, 429, { error: 'Забагато спроб. Спробуйте пізніше.' });
      requireDb();
      const body = await readBody(req);
      const customer_name = safeString(body.customer_name,120), customer_phone = safeString(body.customer_phone,30);
      const carrier = body.carrier, city = safeString(body.city,100), branch = safeString(body.branch,160);
      const items = Array.isArray(body.items) ? body.items : [];
      if (customer_name.length < 3 || !validPhone(customer_phone) || !['nova_poshta','ukrposhta'].includes(carrier) || city.length < 2 || branch.length < 2)
        return json(res,400,{error:'Перевірте ім’я, телефон, спосіб доставки, місто та відділення.'});
      if (!items.length || items.length > 50) return json(res,400,{error:'Кошик порожній або містить забагато позицій.'});
      const merged = new Map();
      for (const item of items) {
        const offer_id = safeString(item.offer_id,80), quantity = Number(item.quantity);
        if (!/^[0-9a-f-]{36}$/i.test(offer_id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99)
          return json(res,400,{error:'Некоректна позиція кошика.'});
        merged.set(offer_id,(merged.get(offer_id)||0)+quantity);
        if (merged.get(offer_id)>99) return json(res,400,{error:'Завелика кількість одного товару.'});
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ids = [...merged.keys()];
        const { rows: offers } = await client.query(`
          select o.id,o.product_id,o.supplier_id,o.retail_price,o.purchase_cost,o.availability,
            p.name as product_name,p.sku as product_sku
          from supplier_offers o join products p on p.id=o.product_id
          join suppliers s on s.id=o.supplier_id
          where o.id=any($1::uuid[]) and o.is_active=true and p.is_visible=true and s.is_active=true
          for share of o`, [ids]);
        if (offers.length !== ids.length) { await client.query('ROLLBACK'); return json(res,409,{error:'Деякі товари більше недоступні. Оновіть кошик.'}); }
        if (offers.some(o=>o.availability!=='available'||o.retail_price===null||Number(o.retail_price)<0)) {
          await client.query('ROLLBACK'); return json(res,409,{error:'Наявність або ціна деяких товарів змінилася. Перевірте кошик.'});
        }
        if (new Set(offers.map(o=>o.supplier_id)).size!==1) {
          await client.query('ROLLBACK'); return json(res,400,{error:'Одне замовлення може містити товари лише одного постачальника. Розділіть кошик.'});
        }
        const byId = new Map(offers.map(o=>[o.id,o]));
        const subtotal = ids.reduce((sum,id)=>sum+Number(byId.get(id).retail_price)*merged.get(id),0);
        if (!Number.isFinite(subtotal)||subtotal<=0) { await client.query('ROLLBACK'); return json(res,400,{error:'Некоректна сума замовлення.'}); }
        const { rows: customerRows } = await client.query(`
          insert into customers(full_name,phone) values($1,$2)
          on conflict(phone) do update set full_name=excluded.full_name,updated_at=now()
          returning id`,[customer_name,customer_phone]);
        const { rows: orders } = await client.query(`
          insert into orders(customer_id,customer_name,customer_phone,carrier,city,branch,supplier_id,status,payment_status,delivery_status,subtotal)
          values($1,$2,$3,$4,$5,$6,$7,'new','unpaid','not_shipped',$8)
          returning id,order_number,status,subtotal,created_at`,
          [customerRows[0].id,customer_name,customer_phone,carrier,city,branch,offers[0].supplier_id,subtotal]);
        const order=orders[0];
        for (const id of ids) {
          const o=byId.get(id);
          await client.query(`insert into order_items(order_id,product_id,offer_id,product_name_snapshot,sku_snapshot,supplier_cost_snapshot,unit_price,quantity)
            values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [order.id,o.product_id,o.id,o.product_name,o.product_sku,o.purchase_cost,o.retail_price,merged.get(id)]);
        }
        await client.query('COMMIT');
        return json(res,201,{order:{id:order.id,order_number:order.order_number,status:order.status,subtotal:order.subtotal,created_at:order.created_at},message:'Замовлення прийнято. Очікуйте підтвердження наявності.'});
      } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
      finally { client.release(); }
    }
    return json(res,404,{error:'Маршрут не знайдено'});
  } catch (error) {
    const status=Number(error.status)||500;
    if(status>=500) console.error('API error:',error.message);
    return json(res,status,{error:status===503?'Базу даних ще не підключено.':status>=500?'Помилка сервера. Спробуйте пізніше.':error.message});
  }
}
http.createServer((req,res)=>{handle(req,res);}).listen(PORT,'0.0.0.0',()=>console.log(`VITRANO API listening on ${PORT}`));
