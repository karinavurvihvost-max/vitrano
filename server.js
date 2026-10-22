import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://vitrano-storefront.onrender.com';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const requests = new Map();

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
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (requests.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  requests.set(key, recent);
  return recent.length > RATE_MAX;
}

async function db(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error('Database is not configured');
    err.status = 503;
    throw err;
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const err = new Error('Database request failed');
    err.status = response.status >= 500 ? 502 : response.status;
    err.detail = data;
    throw err;
  }
  return { data, response };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 40_000) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
  }
  try { return JSON.parse(raw || '{}'); }
  catch { const err = new Error('Invalid JSON'); err.status = 400; throw err; }
}

const clean = value => typeof value === 'string' ? value.trim() : '';
const validPhone = value => /^[+\d()\s-]{9,20}$/.test(value);
const safeString = (v, max = 160) => clean(v).slice(0, max);

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin is not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ALLOWED_ORIGIN,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'vary': 'Origin'
    });
    return res.end();
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'vitrano-api', databaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
    }

    if (req.method === 'GET' && url.pathname === '/api/categories') {
      const { data } = await db('categories?select=id,name,slug,sort_order&is_visible=eq.true&order=sort_order.asc,name.asc');
      return json(res, 200, { categories: data || [] });
    }

    if (req.method === 'GET' && url.pathname === '/api/products') {
      const q = safeString(url.searchParams.get('q'), 80);
      const category = safeString(url.searchParams.get('category'), 80);
      const params = new URLSearchParams({
        select: 'id,sku,name,slug,description,characteristics,category_id,image_urls,main_image_url,categories(name),supplier_offers(id,supplier_id,retail_price,availability,last_checked_at,suppliers(name))',
        is_visible: 'eq.true',
        'supplier_offers.is_active': 'eq.true',
        order: 'name.asc',
        limit: '100'
      });
      if (q) params.set('name', `ilike.*${q.replace(/[,*()%]/g, '')}*`);
      if (category) params.set('categories.slug', `eq.${category}`);
      const { data } = await db(`products?${params.toString()}`);
      const products = (data || []).map(p => ({
        ...p,
        offers: (p.supplier_offers || []).map(o => ({
          id: o.id,
          supplier_id: o.supplier_id,
          supplier_name: o.suppliers?.name || 'Постачальник',
          retail_price: o.retail_price,
          availability: o.availability,
          last_checked_at: o.last_checked_at
        })).filter(o => o.retail_price !== null)
      })).filter(p => p.offers.length > 0);
      return json(res, 200, { products });
    }

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      if (rateLimited(req)) return json(res, 429, { error: 'Забагато спроб. Спробуйте пізніше.' });
      const body = await readBody(req);
      const customer_name = safeString(body.customer_name, 120);
      const customer_phone = safeString(body.customer_phone, 30);
      const carrier = body.carrier;
      const city = safeString(body.city, 100);
      const branch = safeString(body.branch, 160);
      const items = Array.isArray(body.items) ? body.items : [];
      if (customer_name.length < 3 || !validPhone(customer_phone) || !['nova_poshta', 'ukrposhta'].includes(carrier) || city.length < 2 || branch.length < 2) {
        return json(res, 400, { error: 'Перевірте ім’я, телефон, спосіб доставки, місто та відділення.' });
      }
      if (!items.length || items.length > 50) return json(res, 400, { error: 'Кошик порожній або містить забагато позицій.' });
      const merged = new Map();
      for (const item of items) {
        const offer_id = safeString(item.offer_id, 80);
        const quantity = Number(item.quantity);
        if (!/^[0-9a-f-]{36}$/i.test(offer_id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
          return json(res, 400, { error: 'Некоректна позиція кошика.' });
        }
        merged.set(offer_id, (merged.get(offer_id) || 0) + quantity);
        if (merged.get(offer_id) > 99) return json(res, 400, { error: 'Завелика кількість одного товару.' });
      }
      const ids = [...merged.keys()];
      const filter = ids.map(id => `"${id}"`).join(',');
      const { data: offers } = await db(`supplier_offers?select=id,product_id,supplier_id,retail_price,purchase_cost,availability,is_active,products!inner(id,name,sku,is_visible)&id=in.(${filter})&is_active=eq.true&products.is_visible=eq.true`);
      if (!offers || offers.length !== ids.length) return json(res, 409, { error: 'Деякі товари більше недоступні. Оновіть кошик.' });
      if (offers.some(o => o.availability !== 'available' || o.retail_price === null || Number(o.retail_price) < 0)) {
        return json(res, 409, { error: 'Наявність або ціна деяких товарів змінилася. Перевірте кошик.' });
      }
      const supplierIds = new Set(offers.map(o => o.supplier_id));
      if (supplierIds.size !== 1) return json(res, 400, { error: 'Одне замовлення може містити товари лише одного постачальника. Розділіть кошик.' });
      const supplier_id = offers[0].supplier_id;
      const byId = new Map(offers.map(o => [o.id, o]));
      const subtotal = ids.reduce((sum, id) => sum + Number(byId.get(id).retail_price) * merged.get(id), 0);
      if (!Number.isFinite(subtotal) || subtotal <= 0) return json(res, 400, { error: 'Некоректна сума замовлення.' });

      const { data: customerRows } = await db('customers?on_conflict=phone&select=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{ full_name: customer_name, phone: customer_phone }])
      });
      const customer_id = customerRows?.[0]?.id || null;
      const { data: orders } = await db('orders?select=id,order_number,status,subtotal,created_at', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          customer_id, customer_name, customer_phone, carrier, city, branch,
          supplier_id, status: 'new', payment_status: 'unpaid',
          delivery_status: 'not_shipped', subtotal
        }])
      });
      const order = orders?.[0];
      if (!order) throw new Error('Order creation returned no row');
      const rows = ids.map(id => {
        const offer = byId.get(id);
        return {
          order_id: order.id,
          product_id: offer.product_id,
          offer_id: offer.id,
          product_name_snapshot: offer.products.name,
          sku_snapshot: offer.products.sku || null,
          supplier_cost_snapshot: offer.purchase_cost,
          unit_price: Number(offer.retail_price),
          quantity: merged.get(id)
        };
      });
      try {
        await db('order_items', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(rows)
        });
      } catch (error) {
        // Do not leave an empty order behind if item insertion fails.
        await db(`orders?id=eq.${order.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
        throw error;
      }
      return json(res, 201, {
        order: { id: order.id, order_number: order.order_number, status: order.status, subtotal: order.subtotal, created_at: order.created_at },
        message: 'Замовлення прийнято. Очікуйте підтвердження наявності.'
      });
    }

    return json(res, 404, { error: 'Маршрут не знайдено' });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('API error:', error.message, error.detail || '');
    return json(res, status, { error: status === 503 ? 'Базу даних ще не підключено.' : status >= 500 ? 'Помилка сервера. Спробуйте пізніше.' : error.message });
  }
}

http.createServer((req, res) => { handle(req, res); }).listen(PORT, '0.0.0.0', () => {
  console.log(`VITRANO API listening on ${PORT}`);
});
