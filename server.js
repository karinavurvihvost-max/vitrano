import http from 'node:http';
import pg from 'pg';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://vitrano-storefront.onrender.com';
const OPEN_ADMIN_ACCESS = process.env.OPEN_ADMIN_ACCESS === 'true';
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
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
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
    if (raw.length > 1800000) { const e = new Error('Файл завеликий. Стисніть фото або виберіть інше.'); e.status = 413; throw e; }
  }
  try { return JSON.parse(raw || '{}'); }
  catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}
const clean = v => typeof v === 'string' ? v.trim() : '';
const safeString = (v, max = 160) => clean(v).slice(0, max);
const validPhone = v => /^[+\d()\s-]{9,20}$/.test(v);
const requireDb = () => { if (!pool) { const e = new Error('Database not configured'); e.status = 503; throw e; } };
const hashToken = token => createHash('sha256').update(token).digest('hex');

function htmlText(value='') {
  return String(value).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#039;|&apos;/gi,"'")
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/\s+/g,' ').trim();
}
function sigaSlug(value='') {
  return String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9а-яіїєґ]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,100) || 'product';
}
function attrValue(tag, attr) {
  const m = String(tag).match(new RegExp('\\b'+attr+'\\s*=\\s*"([^"]*)"','i'));
  return m ? m[1].replace(/&amp;/g,'&') : '';
}
function parseSigaHtmlPage(html) {
  const cards = [...String(html).matchAll(/<li\b(?=[^>]*class=["'][^"']*\bproduct\b[^"']*["'])[^>]*>[\s\S]*?<\/li>/gi)].map(m=>m[0]);
  const out = [];
  for (const card of cards) {
    const titleMatch = card.match(/<(?:h2|h3)[^>]*class=["'][^"']*woocommerce-loop-product__title[^"']*["'][^>]*>([\s\S]*?)<\/(?:h2|h3)>/i);
    const name = htmlText(titleMatch?.[1] || '');
    const linkTag = card.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    let permalink = (linkTag?.[1] || '').replace(/&amp;/g,'&');
    try { permalink = new URL(permalink, 'https://siga-ua.net').href; } catch { continue; }
    if (!name || !permalink.startsWith('https://siga-ua.net/')) continue;
    const priceBlock = card.match(/<(?:span|p)[^>]*class=["'][^"']*(?:price|woocommerce-Price-amount)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|p)>/i);
    const priceText = htmlText(priceBlock?.[1] || card.match(/<bdi[^>]*>([\s\S]*?)<\/bdi>/i)?.[1] || '');
    const priceMatch = priceText.match(/[\d][\d\s.,]*/);
    if (!priceMatch) continue;
    const price = Number(priceMatch[0].replace(/\s/g,'').replace(/,/g,''));
    if (!Number.isFinite(price) || price <= 0) continue;
    const imgTag = card.match(/<img\b[^>]*>/i)?.[0] || '';
    let image = attrValue(imgTag,'data-src') || attrValue(imgTag,'data-lazy-src') || attrValue(imgTag,'src');
    try { image = image ? new URL(image,'https://siga-ua.net').href : ''; } catch { image=''; }
    const categoryMatch = card.match(/<(?:span|div)[^>]*class=["'][^"']*(?:ast-woo-product-category|product-category)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    let category = htmlText(categoryMatch?.[1] || '');
    if (!category) {
      const cls = card.match(/\bproduct_cat-([a-z0-9-]+)/i)?.[1] || '';
      const map = {'king-size':'King size','demi':'Demi','nano':'Nano','super-slims':'Super slims','bez-filtra':'Без фільтра','sticks-iqos':'Стіки для IQOS','elektronni-sigareti':'Електронні сигарети','duty-free':'Duty Free','aktsiz-ukraina':'Акциз Україна'};
      category = map[cls] || 'Інше';
    }
    out.push({name,permalink,price,image,category,sourceInStock:!(/outofstock/i.test(card)||/очікується/i.test(htmlText(card)))});
  }
  return out;
}
async function fetchSigaCatalog() {
  const apiItems = [];
  let apiWorked = false, totalPages = 20;
  for (let page=1; page<=Math.min(totalPages,20); page++) {
    try {
      const response = await fetch('https://siga-ua.net/wp-json/wc/store/v1/products?per_page=100&page='+page, {
        headers:{'accept':'application/json','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','accept-language':'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7','referer':'https://siga-ua.net/shop/'},
        signal:AbortSignal.timeout(12000)
      });
      if (!response.ok) { if(page===1) apiWorked=false; break; }
      const payload = await response.json();
      if (!Array.isArray(payload)) { if(page===1) apiWorked=false; break; }
      apiWorked = true;
      const headerPages = Number(response.headers.get('X-WP-TotalPages'));
      if (Number.isFinite(headerPages) && headerPages>0) totalPages=Math.min(headerPages,20);
      for (const p of payload) {
        const permalink = typeof p.permalink==='string' ? p.permalink : '';
        const rawPrice = Number(p.prices?.price);
        const minor = Number.isFinite(Number(p.prices?.currency_minor_unit)) ? Number(p.prices.currency_minor_unit) : 2;
        const price = rawPrice / Math.pow(10,minor);
        if (!p.name || !permalink.startsWith('https://siga-ua.net/') || !Number.isFinite(price) || price<=0) continue;
        apiItems.push({
          name:htmlText(p.name),permalink,price,
          image:Array.isArray(p.images) && p.images[0]?.src ? String(p.images[0].src) : '',
          category:Array.isArray(p.categories) && p.categories[0]?.name ? htmlText(p.categories[0].name) : 'Інше',
          sourceInStock:p.is_in_stock===true
        });
      }
      if (!payload.length || (Number.isFinite(headerPages) && page>=headerPages)) break;
    } catch (e) { if(page===1) apiWorked=false; break; }
  }
  if (apiWorked && apiItems.length) return {items:apiItems,source:'WooCommerce Store API'};
  const items = [];
  for (let page=1; page<=20; page++) {
    const path = page===1 ? 'https://siga-ua.net/shop/' : 'https://siga-ua.net/shop/page/'+page+'/';
    const response = await fetch(path,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','accept-language':'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7','referer':'https://siga-ua.net/shop/'},signal:AbortSignal.timeout(12000)});
    if (!response.ok) { if(page===1) throw new Error('Siga UA не віддає каталог (HTTP '+response.status+').'); break; }
    const html = await response.text();
    const found = parseSigaHtmlPage(html);
    if (!found.length) break;
    items.push(...found);
    if (!/woocommerce-pagination|page-numbers|Показано\s+\d+/i.test(html)) break;
  }
  const unique = [...new Map(items.map(p=>[p.permalink,p])).values()];
  if (!unique.length) throw new Error('Не вдалося розібрати товари Siga UA. Імпорт не виконувався.');
  return {items:unique,source:'HTML catalog'};
}
async function importSigaCatalog() {
  requireDb();
  const {items,source} = await fetchSigaCatalog();
  if (!items.length) throw new Error('Каталог Siga UA порожній; базу не змінено.');
  const client=await pool.connect();
  let created=0, updated=0;
  try {
    await client.query('BEGIN');
    let supplier=(await client.query("select id from suppliers where name='Siga UA — імпорт' order by created_at limit 1")).rows[0];
    if(!supplier) supplier=(await client.query("insert into suppliers(name,contact_name,notes,is_active) values('Siga UA — імпорт','Імпорт каталогу','Імпортовані дані; перед публікацією перевірити право використання фото, ліцензійні та вікові вимоги.',true) returning id")).rows[0];
    for (const item of items) {
      const permalink = item.permalink;
      const sourceKey = createHash('sha256').update(permalink).digest('hex').slice(0,12);
      const sku = 'SIGA-'+sourceKey.toUpperCase();
      const slug = 'siga-'+sigaSlug(item.name).slice(0,90)+'-'+sourceKey;
      const categoryName = 'Siga UA — '+safeString(item.category || 'Інше',80);
      const categorySlug = 'siga-'+sigaSlug(item.category || 'other').slice(0,60);
      const cat = await client.query('insert into categories(name,slug,is_visible) values($1,$2,false) on conflict(name) do update set name=excluded.name returning id',[categoryName,categorySlug]);
      const image = typeof item.image==='string' && item.image.startsWith('https://') ? item.image.slice(0,1000) : '';
      const meta = JSON.stringify({siga_source_url:permalink,siga_source:'siga-ua.net',siga_source_category:item.category||'Інше',siga_source_in_stock:Boolean(item.sourceInStock),siga_imported_at:new Date().toISOString(),siga_needs_review:true});
      const existing = (await client.query("select id from products where characteristics->>'siga_source_url'=$1 or sku=$2 limit 1",[permalink,sku])).rows[0];
      let productId;
      if(existing) {
        productId=existing.id;
        await client.query("update products set sku=$2,name=$3,slug=$4,description=$5,category_id=$6,image_urls=$7,main_image_url=$8,is_visible=false,characteristics=coalesce(characteristics,'{}'::jsonb)||$9::jsonb,updated_at=now() where id=$1",
          [productId,sku,safeString(item.name,180),slug,'Імпортовано з Siga UA. Перевірити актуальність ціни, наявність, документи та право використання зображення перед публікацією.',cat.rows[0].id,image?[image]:[],image||null,meta]);
        updated++;
      } else {
        const p=await client.query('insert into products(sku,name,slug,description,characteristics,category_id,image_urls,main_image_url,is_visible) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,false) returning id',
          [sku,safeString(item.name,180),slug,'Імпортовано з Siga UA. Перевірити актуальність ціни, наявність, документи та право використання зображення перед публікацією.',meta,cat.rows[0].id,image?[image]:[],image||null]);
        productId=p.rows[0].id; created++;
      }
      await client.query("insert into supplier_offers(product_id,supplier_id,purchase_cost,retail_price,availability,is_active) values($1,$2,null,$3,'check',true) on conflict(product_id,supplier_id) do update set retail_price=excluded.retail_price,purchase_cost=null,availability='check',is_active=true,updated_at=now()",
        [productId,supplier.id,Number(item.price.toFixed(2))]);
    }
    await client.query('insert into audit_log(action,entity_type,details) values($1,$2,$3)',
      ['catalog.import','product',JSON.stringify({source:'siga-ua.net',source_method:source,found:items.length,created,updated,hidden:true})]);
    await client.query('COMMIT');
    return {ok:true,source,found:items.length,created,updated,hidden:true,message:'Імпорт завершено. Товари залишені прихованими до перевірки наявності, ліцензійних вимог і прав на зображення.'};
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally { client.release(); }
}

const passwordHash = password => scryptSync(password, 'vitrano-customer-v1', 64).toString('hex');
async function ensureCustomerAuthSchema() {
  await pool.query('alter table customers add column if not exists password_hash text');
  await pool.query('alter table customers add column if not exists session_token_hash text');
  await pool.query('alter table customers add column if not exists session_expires_at timestamptz');
}
async function customerFromRequest(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (token.length < 32 || token.length > 200) return null;
  await ensureCustomerAuthSchema();
  const { rows } = await pool.query('select id,full_name,phone from customers where session_token_hash=$1 and session_expires_at>now() limit 1',[hashToken(token)]);
  return rows[0] || null;
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin is not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '600', vary: 'Origin' });
    return res.end();
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let databaseConnected = false;
      if (pool) { try { await pool.query('select 1'); databaseConnected = true; } catch {} }
      return json(res, 200, { ok: true, service: 'vitrano-api', databaseConfigured: Boolean(pool), databaseConnected });
    }
    if (req.method === 'GET' && url.pathname === '/api/storefront-settings') {
      requireDb();
      const {rows}=await pool.query("select setting_value from storefront_settings where setting_key='hero_banner' limit 1");
      const value=rows[0]?.setting_value||{}; return json(res,200,{hero_banner:value.hero_banner||value.banners?.[0]||value,hero_banners:Array.isArray(value.banners)?value.banners: [value.hero_banner||value]});
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
        select p.id,p.sku,p.name,p.slug,p.description,p.characteristics,p.category_id,p.image_urls,p.main_image_url,p.promo_price,p.promotion_start,p.promotion_end,
          coalesce(rv.average_rating,0)::numeric(2,1) as average_rating,coalesce(rv.review_count,0)::int as review_count,
          case when c.id is null then null else json_build_object('name',c.name,'slug',c.slug) end as categories,
          coalesce(json_agg(json_build_object('id',o.id,'supplier_id',o.supplier_id,'supplier_name',s.name,'retail_price',o.retail_price,'availability',o.availability,'last_checked_at',o.last_checked_at))
            filter (where o.id is not null and o.retail_price is not null), '[]'::json) as offers
        from products p left join categories c on c.id=p.category_id
        left join supplier_offers o on o.product_id=p.id and o.is_active=true
        left join suppliers s on s.id=o.supplier_id and s.is_active=true
        left join (select product_id,avg(rating)::numeric(2,1) as average_rating,count(*)::int as review_count from reviews where status='published' group by product_id) rv on rv.product_id=p.id
        where ${filters.join(' and ')}
        group by p.id,c.id,rv.average_rating,rv.review_count order by p.name asc limit 100`, params);
      return json(res, 200, { products: rows.filter(p => p.offers.length > 0) });
    }
    const publicReviewMatch=url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/reviews$/i);
    if(publicReviewMatch&&req.method==='GET'){
      requireDb();
      const {rows}=await pool.query("select r.id,r.rating,r.body,r.admin_reply,r.created_at,coalesce(c.full_name,'Покупець') as customer_name from reviews r left join customers c on c.id=r.customer_id where r.product_id=$1 and r.status='published' order by r.created_at desc limit 50",[publicReviewMatch[1]]);
      return json(res,200,{reviews:rows});
    }
    if(publicReviewMatch&&req.method==='POST'){
      if(rateLimited(req))return json(res,429,{error:'Забагато спроб. Спробуйте пізніше.'});
      requireDb();
      const b=await readBody(req),rating=Number(b.rating),body=safeString(b.body,1200);
      if(!Number.isInteger(rating)||rating<1||rating>5)return json(res,400,{error:'Оберіть оцінку від 1 до 5 зірок.'});
      if(body.length>1200)return json(res,400,{error:'Відгук задовгий.'});
      const p=await pool.query('select id from products where id=$1 and is_visible=true',[publicReviewMatch[1]]);
      if(!p.rows.length)return json(res,404,{error:'Товар не знайдено.'});
      await pool.query("insert into reviews(product_id,rating,body,status) values($1,$2,$3,'pending')",[publicReviewMatch[1],rating,body||null]);
      return json(res,201,{message:'Дякуємо! Відгук надіслано на перевірку перед публікацією.'});
    }
    if (url.pathname.startsWith('/api/customer/')) {
      requireDb(); await ensureCustomerAuthSchema();
      if (req.method === 'POST' && url.pathname === '/api/customer/register') {
        if (rateLimited(req)) return json(res,429,{error:'Забагато спроб. Спробуйте через хвилину.'});
        const b=await readBody(req), name=safeString(b.full_name,120), phone=safeString(b.phone,30).replace(/[()\\s-]/g,''), password=String(b.password||'');
        if(name.length<2||!validPhone(phone)||password.length<8||password.length>100) return json(res,400,{error:'Вкажіть ім’я, телефон і пароль від 8 символів.'});
        const existing=await pool.query('select id,password_hash,exists(select 1 from orders o where o.customer_id=customers.id) as has_orders from customers where phone=$1 limit 1',[phone]);
        if(existing.rows.length && (existing.rows[0].password_hash || existing.rows[0].has_orders)) return json(res,409,{error:'Цей номер уже пов’язаний із замовленнями або кабінетом. Для безпеки зверніться до підтримки, щоб підтвердити номер.'});
        const token=randomBytes(32).toString('base64url');
        const result=await pool.query('insert into customers(full_name,phone,password_hash,session_token_hash,session_expires_at) values($1,$2,$3,$4,now()+interval \'30 days\') on conflict(phone) do update set full_name=excluded.full_name,password_hash=excluded.password_hash,session_token_hash=excluded.session_token_hash,session_expires_at=excluded.session_expires_at,updated_at=now() returning id,full_name,phone',[name,phone,passwordHash(password),hashToken(token)]);
        return json(res,201,{token,customer:result.rows[0]});
      }
      if (req.method === 'POST' && url.pathname === '/api/customer/login') {
        if (rateLimited(req)) return json(res,429,{error:'Забагато спроб. Спробуйте пізніше.'});
        const b=await readBody(req), phone=safeString(b.phone,30).replace(/[()\\s-]/g,''), password=String(b.password||'');
        const {rows}=await pool.query('select id,full_name,phone,password_hash from customers where phone=$1 and password_hash is not null limit 1',[phone]);
        const supplied=Buffer.from(passwordHash(password));
        if(!rows.length||supplied.length!==Buffer.from(rows[0].password_hash).length||!timingSafeEqual(supplied,Buffer.from(rows[0].password_hash))) return json(res,401,{error:'Невірний номер телефону або пароль.'});
        const token=randomBytes(32).toString('base64url');
        await pool.query('update customers set session_token_hash=$1,session_expires_at=now()+interval \'30 days\' where id=$2',[hashToken(token),rows[0].id]);
        return json(res,200,{token,customer:{id:rows[0].id,full_name:rows[0].full_name,phone:rows[0].phone}});
      }
      if (req.method === 'POST' && url.pathname === '/api/customer/logout') { const customer=await customerFromRequest(req); if(customer) await pool.query('update customers set session_token_hash=null,session_expires_at=null where id=$1',[customer.id]); return json(res,200,{ok:true}); }
      if (req.method === 'GET' && url.pathname === '/api/customer/me') {
        const customer=await customerFromRequest(req); if(!customer)return json(res,401,{error:'Увійдіть до кабінету.'});
        const {rows}=await pool.query('select o.id,o.order_number,o.status,o.payment_status,o.delivery_status,o.subtotal,o.created_at,o.carrier,o.region,o.city,o.branch,o.ttn,coalesce((select json_agg(json_build_object(\'name\',i.product_name_snapshot,\'quantity\',i.quantity,\'unit_price\',i.unit_price,\'line_total\',i.line_total)) from order_items i where i.order_id=o.id),\'[]\'::json) as items from orders o where o.customer_id=$1 order by o.created_at desc limit 50',[customer.id]);
        return json(res,200,{customer,orders:rows});
      }
      if (req.method === 'PATCH' && url.pathname === '/api/customer/profile') {
        const customer=await customerFromRequest(req);
        if(!customer)return json(res,401,{error:'Увійдіть до кабінету.'});
        const b=await readBody(req), name=safeString(b.full_name,120);
        if(name.length<3)return json(res,400,{error:'Вкажіть ім’я та прізвище.'});
        const {rows}=await pool.query('update customers set full_name=$1,updated_at=now() where id=$2 returning id,full_name,phone',[name,customer.id]);
        return json(res,200,{customer:rows[0],message:'Профіль збережено.'});
      }
      return json(res,404,{error:'Маршрут кабінету не знайдено.'});
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      if (rateLimited(req)) return json(res, 429, { error: 'Забагато спроб. Спробуйте пізніше.' });
      requireDb();
      const body = await readBody(req);
      const customer_name = safeString(body.customer_name,120), customer_phone = safeString(body.customer_phone,30);
      const carrier = body.carrier, region = safeString(body.region,100), city = safeString(body.city,100), branch = safeString(body.branch,160);
      const items = Array.isArray(body.items) ? body.items : [];
      if (customer_name.length < 3 || !validPhone(customer_phone) || !['nova_poshta','ukrposhta'].includes(carrier) || region.length < 2 || city.length < 2 || branch.length < 1)
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
            case when p.promo_price>0 and p.promo_price<o.retail_price and (p.promotion_start is null or p.promotion_start<=now()) and (p.promotion_end is null or p.promotion_end>=now()) then p.promo_price else o.retail_price end as effective_price,
            s.name as supplier_name,p.name as product_name,p.sku as product_sku
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
        const supplierName = String(offers[0].supplier_name || '').trim();
        const minimumItems = supplierName === 'Склад 1' ? 3 : supplierName === 'Склад 2' ? 2 : 1;
        const totalItems = ids.reduce((sum,id)=>sum+(merged.get(id)||0),0);
        if (totalItems < minimumItems) {
          await client.query('ROLLBACK');
          return json(res,400,{error:'Мінімальне замовлення для «'+supplierName+'» — '+minimumItems+' товари. Зараз у кошику: '+totalItems+'. Додайте ще '+(minimumItems-totalItems)+'.'});
        }
        const byId = new Map(offers.map(o=>[o.id,o]));
        const subtotal = ids.reduce((sum,id)=>sum+Number(byId.get(id).effective_price)*merged.get(id),0);
        if (!Number.isFinite(subtotal)||subtotal<=0) { await client.query('ROLLBACK'); return json(res,400,{error:'Некоректна сума замовлення.'}); }
        const { rows: customerRows } = await client.query(`
          insert into customers(full_name,phone) values($1,$2)
          on conflict(phone) do update set full_name=excluded.full_name,updated_at=now()
          returning id`,[customer_name,customer_phone]);
        const { rows: orders } = await client.query(`
          insert into orders(customer_id,customer_name,customer_phone,carrier,region,city,branch,supplier_id,status,payment_status,delivery_status,subtotal)
          values($1,$2,$3,$4,$5,$6,$7,$8,'new','unpaid','not_shipped',$9)
          returning id,order_number,status,subtotal,created_at`,
          [customerRows[0].id,customer_name,customer_phone,carrier,region,city,branch,offers[0].supplier_id,subtotal]);
        const order=orders[0];
        for (const id of ids) {
          const o=byId.get(id);
          await client.query(`insert into order_items(order_id,product_id,offer_id,product_name_snapshot,sku_snapshot,supplier_cost_snapshot,unit_price,quantity)
            values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [order.id,o.product_id,o.id,o.product_name,o.product_sku,o.purchase_cost,o.effective_price,merged.get(id)]);
        }
        await client.query('COMMIT');
        return json(res,201,{order:{id:order.id,order_number:order.order_number,status:order.status,subtotal:order.subtotal,created_at:order.created_at},message:'Замовлення прийнято. Очікуйте підтвердження наявності.'});
      } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
      finally { client.release(); }
    }

    if (url.pathname.startsWith('/api/admin/')) {
      requireDb();
      const configured = process.env.ADMIN_API_TOKEN || '';
      if (!OPEN_ADMIN_ACCESS) {
        if (!configured) return json(res,503,{error:'Адмін-доступ ще не налаштований.'});
        if ((req.headers.authorization || '') !== 'Bearer ' + configured) return json(res,401,{error:'Потрібна авторизація адміністратора.'});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/storefront-settings') {
        const {rows}=await pool.query("select setting_value from storefront_settings where setting_key='hero_banner' limit 1");
        return json(res,200,{hero_banner:rows[0]?.setting_value||{}});
      }
      if (req.method === 'PATCH' && url.pathname === '/api/admin/storefront-settings') {
        const b=await readBody(req);
        const cleanBanner=x=>({eyebrow:safeString(x?.eyebrow,100),title:safeString(x?.title,180),description:safeString(x?.description,500),button_text:safeString(x?.button_text,60),background:['blue','light','dark','purple','green'].includes(x?.background)?x.background:'blue',image_url:typeof x?.image_url==='string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x.image_url) && x.image_url.length<=1500000 ? x.image_url : ''});
        let banners;
        if(Array.isArray(b.banners)){if(b.banners.length!==5)return json(res,400,{error:'Потрібно передати рівно 5 банерів.'});banners=b.banners.map(cleanBanner);if(banners.some(x=>!x.title||!x.description||!x.button_text))return json(res,400,{error:'Заповніть заголовок, опис і текст кнопки для всіх 5 банерів.'});for(let i=0;i<5;i++){const raw=b.banners[i]?.image_url;if(typeof raw==='string'&&raw.startsWith('data:image/')&&!banners[i].image_url)return json(res,400,{error:'Фото банера №'+(i+1)+' завелике або формат не підтримується.'});}}
        else {const value=cleanBanner(b);if(!value.title||!value.description||!value.button_text)return json(res,400,{error:'Заповніть заголовок, опис і текст кнопки.'});if(typeof b.image_url==='string'&&b.image_url.startsWith('data:image/')&&!value.image_url)return json(res,400,{error:'Фото завелике або формат не підтримується.'});banners=[value,value,value,value,value];}
        const payload={hero_banner:banners[0],banners};
        await pool.query("insert into storefront_settings(setting_key,setting_value,updated_at) values('hero_banner',$1::jsonb,now()) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now()",[JSON.stringify(payload)]);
        await pool.query("insert into audit_log(action,entity_type,details) values($1,$2,$3)",['storefront.banner.update','storefront_settings',JSON.stringify({count:banners.length,titles:banners.map(x=>x.title)})]);
        return json(res,200,{message:'Усі 5 банерів збережено.',hero_banner:banners[0],hero_banners:banners});
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/import-siga') {
        const result = await importSigaCatalog();
        return json(res,200,result);
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
        const [p,o,s,fin] = await Promise.all([
          pool.query('select count(*)::int as count from products'),
          pool.query('select count(*)::int as count from orders'),
          pool.query('select count(*)::int as count from suppliers where is_active=true'),
          pool.query("select coalesce(sum(subtotal),0)::numeric(12,2) as revenue from orders where lower(trim(status)) not in ('cancelled','returned','скасовано','повернення')")
        ]);
        return json(res,200,{products:p.rows[0].count,orders:o.rows[0].count,suppliers:s.rows[0].count,revenue:fin.rows[0].revenue});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/reviews'){
        const {rows}=await pool.query("select r.id,r.product_id,r.rating,r.body,r.status,r.admin_reply,r.created_at,p.name as product_name,coalesce(c.full_name,'Покупець') as customer_name from reviews r join products p on p.id=r.product_id left join customers c on c.id=r.customer_id order by case when r.status='pending' then 0 else 1 end,r.created_at desc limit 300");
        return json(res,200,{reviews:rows});
      }
      const reviewAdminMatch=url.pathname.match(/^\/api\/admin\/reviews\/([0-9a-f-]{36})$/i);
      if(req.method==='PATCH'&&reviewAdminMatch){
        const b=await readBody(req),status=safeString(b.status,20),reply=safeString(b.admin_reply,1200);
        if(!['pending','published','rejected'].includes(status))return json(res,400,{error:'Некоректний статус відгуку.'});
        await pool.query('update reviews set status=$1,admin_reply=$2 where id=$3',[status,reply||null,reviewAdminMatch[1]]);
        await pool.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)',['review.moderate','review',reviewAdminMatch[1],JSON.stringify({status})]);
        return json(res,200,{message:'Відгук оновлено.'});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/products') {
        const {rows}=await pool.query(`select p.id,p.sku,p.name,p.slug,p.description,p.characteristics,p.category_id,p.image_urls,p.main_image_url,p.promo_price,p.promotion_start,p.promotion_end,p.is_visible,c.name as category,c.slug as category_slug,
          coalesce(json_agg(json_build_object('id',o.id,'supplier_id',o.supplier_id,'supplier_name',s.name,'retail_price',o.retail_price,'purchase_cost',o.purchase_cost,'availability',o.availability,'is_active',o.is_active)) filter(where o.id is not null),'[]'::json) as offers
          from products p left join categories c on c.id=p.category_id left join supplier_offers o on o.product_id=p.id left join suppliers s on s.id=o.supplier_id group by p.id,c.id order by p.created_at desc`);
        return json(res,200,{products:rows});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
        const {rows}=await pool.query(`select o.*,s.name as supplier_name,coalesce((select json_agg(json_build_object('name',i.product_name_snapshot,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total)) from order_items i where i.order_id=o.id),'[]'::json) as items from orders o left join suppliers s on s.id=o.supplier_id order by o.created_at desc limit 300`);
        return json(res,200,{orders:rows});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/suppliers') {
        const {rows}=await pool.query('select id,name,contact_name,phone,messenger,is_active,notes,created_at from suppliers order by created_at desc');
        return json(res,200,{suppliers:rows});
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/products') {
        const b=await readBody(req), name=safeString(b.name,180), category=safeString(b.category,100), mode=safeString(b.supplier_mode,40);
        const price1=b.price_1==null||b.price_1===''?null:Number(b.price_1), price2=b.price_2==null||b.price_2===''?null:Number(b.price_2), cost1=b.purchase_cost_1===''||b.purchase_cost_1==null?null:Number(b.purchase_cost_1), cost2=b.purchase_cost_2===''||b.purchase_cost_2==null?null:Number(b.purchase_cost_2), cost=b.purchase_cost===''||b.purchase_cost==null?null:Number(b.purchase_cost);
        const warehouses=mode==='both'?['Склад 1','Склад 2']:['Склад 1','Склад 2'].includes(mode)?[mode]:[];
        if(name.length<2||!category||!warehouses.length||(warehouses.includes('Склад 1')&&(!Number.isFinite(price1)||price1<=0))||(warehouses.includes('Склад 2')&&(!Number.isFinite(price2)||price2<=0))||(cost!==null&&(!Number.isFinite(cost)||cost<0))||(warehouses.includes('Склад 1')&&cost1!==null&&(!Number.isFinite(cost1)||cost1<0))||(warehouses.includes('Склад 2')&&cost2!==null&&(!Number.isFinite(cost2)||cost2<0))) return json(res,400,{error:'Перевірте назву, постачальника, ціну продажу та ціну постачальника.'});
        const slug=(safeString(b.slug,180)||name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яіїєґ]+/gi,'-').replace(/^-|-$/g,'').slice(0,170)+'-'+Date.now().toString(36);
        const client=await pool.connect();
        try {
          await client.query('BEGIN');
          const catSlug=category.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яіїєґ]+/gi,'-').replace(/^-|-$/g,'').slice(0,80)||'other';
          const cat=await client.query('insert into categories(name,slug) values($1,$2) on conflict(name) do update set name=excluded.name returning id',[category,catSlug]);
          const p=await client.query('insert into products(sku,name,slug,description,category_id,image_urls,main_image_url,is_visible) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',
            [safeString(b.sku,80)||null,name,slug,safeString(b.description,3000),cat.rows[0].id,Array.isArray(b.image_urls)?b.image_urls.filter(x=>typeof x==='string'&&/^https:\/\//.test(x)).slice(0,8):[],(typeof b.main_image_url==='string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.main_image_url) && b.main_image_url.length<=1500000 ? b.main_image_url : safeString(b.main_image_url,1000))||null,b.is_visible===true]);
          for (const warehouse of warehouses) {
            let sup=await client.query('select id from suppliers where name=$1 order by created_at limit 1',[warehouse]);
            if(!sup.rows.length) sup=await client.query('insert into suppliers(name) values($1) returning id',[warehouse]);
            const price=warehouse==='Склад 1'?price1:price2, offerCost=warehouse==='Склад 1'?(cost1===null?cost:cost1):(cost2===null?cost:cost2);
            const offer=await client.query('insert into supplier_offers(product_id,supplier_id,purchase_cost,retail_price,availability,is_active) values($1,$2,$3,$4,$5,true) returning id',
              [p.rows[0].id,sup.rows[0].id,offerCost,price,['available','check','unavailable'].includes(b.availability)?b.availability:'check']);
            if (b.markup_type && ['amount','percent'].includes(b.markup_type) && Number.isFinite(Number(b.markup_value)) && Number(b.markup_value)>=0) {
              await client.query("update products set characteristics=coalesce(characteristics,'{}'::jsonb)||jsonb_build_object('vitrano_markup',coalesce(characteristics->'vitrano_markup','{}'::jsonb)||jsonb_build_object($1::text,jsonb_build_object('type',$2::text,'value',$3::numeric))) where id=$4",
                [offer.rows[0].id,b.markup_type,Number(b.markup_value),p.rows[0].id]);
            }
          }
          await client.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)', ['product.create','product',p.rows[0].id,JSON.stringify({name})]);
          await client.query('COMMIT');
          return json(res,201,{id:p.rows[0].id,message:'Товар створено.'});
        } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;} finally{client.release();}
      }
      const productMatch=url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
      if (req.method === 'PATCH' && productMatch) {
        const b=await readBody(req), id=productMatch[1];
        if (b.is_visible!==undefined) { await pool.query('update products set is_visible=$1,updated_at=now() where id=$2',[Boolean(b.is_visible),id]); if(Boolean(b.is_visible)) await pool.query('update categories set is_visible=true where id=(select category_id from products where id=$1)',[id]); }
        if (b.name!==undefined) await pool.query('update products set name=$1,updated_at=now() where id=$2',[safeString(b.name,180),id]);
        if (b.sku!==undefined) await pool.query('update products set sku=$1,updated_at=now() where id=$2',[safeString(b.sku,80)||null,id]);
        if (b.description!==undefined) await pool.query('update products set description=$1,updated_at=now() where id=$2',[safeString(b.description,3000),id]);
        if (b.promo_price!==undefined||b.promotion_start!==undefined||b.promotion_end!==undefined) { const raw=b.promo_price; const promo=raw===null||raw===''?null:Number(raw); if(raw!==undefined&&raw!==null&&raw!==''&&(!Number.isFinite(promo)||promo<0))return json(res,400,{error:'Некоректна акційна ціна.'}); const start=b.promotion_start?new Date(b.promotion_start):null,end=b.promotion_end?new Date(b.promotion_end):null; if(b.promotion_start&&Number.isNaN(start.getTime()))return json(res,400,{error:'Некоректна дата початку акції.'}); if(b.promotion_end&&Number.isNaN(end.getTime()))return json(res,400,{error:'Некоректна дата завершення акції.'}); if(start&&end&&end<=start)return json(res,400,{error:'Завершення акції має бути пізніше початку.'}); await pool.query('update products set promo_price=$1,promotion_start=$2,promotion_end=$3,updated_at=now() where id=$4',[raw===undefined?null:promo,b.promotion_start||null,b.promotion_end||null,id]); }
        if (b.category!==undefined) { const category=safeString(b.category,100)||'Інше'; const slug=category.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яіїєґ]+/gi,'-').replace(/^-|-$/g,'').slice(0,80)||'other'; const cat=await pool.query('insert into categories(name,slug) values($1,$2) on conflict(name) do update set name=excluded.name returning id',[category,slug]); await pool.query('update products set category_id=$1,updated_at=now() where id=$2',[cat.rows[0].id,id]); }
        if (b.main_image_url!==undefined) { const img=typeof b.main_image_url==='string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.main_image_url) && b.main_image_url.length<=1500000 ? b.main_image_url : safeString(b.main_image_url,1000); if(typeof img==='string'&&img.startsWith('data:image/')&&img.length>1500000)return json(res,400,{error:'Фото завелике. Виберіть менше фото.'}); await pool.query('update products set main_image_url=$1,updated_at=now() where id=$2',[img||null,id]); }
        if (b.image_urls!==undefined) { if(!Array.isArray(b.image_urls)||b.image_urls.length>8||b.image_urls.some(x=>typeof x!=='string'||(!/^https:\/\//i.test(x)&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x))||x.length>1500000)) return json(res,400,{error:'Фото: додайте до 8 коректних HTTPS-посилань або зображень у підтримуваному форматі.'}); await pool.query('update products set image_urls=$1,updated_at=now() where id=$2',[b.image_urls,id]); }
        if (b.offer_id && (b.retail_price!==undefined||b.purchase_cost!==undefined||b.availability!==undefined)) {
          if (b.retail_price!==undefined && (!Number.isFinite(Number(b.retail_price)) || Number(b.retail_price)<0)) return json(res,400,{error:'Некоректна ціна.'});
          if (b.purchase_cost!==undefined && b.purchase_cost!==null && (!Number.isFinite(Number(b.purchase_cost)) || Number(b.purchase_cost)<0)) return json(res,400,{error:'Некоректна собівартість.'});
          if (b.availability!==undefined && !['available','check','unavailable'].includes(b.availability)) return json(res,400,{error:'Некоректний статус наявності.'});
          if (b.markup_type!==undefined && !['amount','percent'].includes(b.markup_type)) return json(res,400,{error:'Некоректний тип націнки.'});
          if (b.markup_value!==undefined && (!Number.isFinite(Number(b.markup_value)) || Number(b.markup_value)<0)) return json(res,400,{error:'Некоректне значення націнки.'});
          const offerUpdate=await pool.query(
            'update supplier_offers set retail_price=coalesce($1,retail_price), purchase_cost=case when $2::boolean then $3::numeric else purchase_cost end, availability=coalesce($4,availability), updated_at=now() where id=$5 and product_id=$6',
            [b.retail_price===undefined?null:Number(b.retail_price),b.purchase_cost!==undefined,b.purchase_cost===undefined||b.purchase_cost===null?null:Number(b.purchase_cost),b.availability||null,b.offer_id,id]
          );
          if(!offerUpdate.rowCount)return json(res,404,{error:'Пропозицію цього постачальника не знайдено для товару.'});
          if (b.markup_type!==undefined && b.markup_value!==undefined) {
            await pool.query("update products set characteristics=coalesce(characteristics,'{}'::jsonb)||jsonb_build_object('vitrano_markup',coalesce(characteristics->'vitrano_markup','{}'::jsonb)||jsonb_build_object($1::text,jsonb_build_object('type',$2::text,'value',$3::numeric))),updated_at=now() where id=$4",
              [b.offer_id,b.markup_type,Number(b.markup_value),id]);
          }
        }
        if (b.warehouse_names !== undefined) {
          const wanted = [...new Set(Array.isArray(b.warehouse_names) ? b.warehouse_names : [])];
          if (!wanted.length || wanted.some(n => !['Склад 1','Склад 2'].includes(n))) return json(res,400,{error:'Оберіть щонайменше один склад.'});
          const current = await pool.query(`select o.id,o.supplier_id,o.retail_price,o.purchase_cost,o.availability,o.is_active,s.name as supplier_name
            from supplier_offers o join suppliers s on s.id=o.supplier_id where o.product_id=$1`,[id]);
          const template = current.rows.find(o=>o.is_active) || current.rows[0];
          if (!template) return json(res,400,{error:'Немає ціни для створення пропозиції на новому складі. Спочатку задайте ціну товару.'});
          for (const warehouse of wanted) {
            let supplier = await pool.query('select id from suppliers where name=$1 limit 1',[warehouse]);
            if (!supplier.rowCount) supplier = await pool.query('insert into suppliers(name,is_active) values($1,true) returning id',[warehouse]);
            const exists = current.rows.find(o=>o.supplier_name===warehouse);
            if (exists) {
              await pool.query('update supplier_offers set is_active=true,updated_at=now() where id=$1',[exists.id]);
            } else {
              await pool.query(`insert into supplier_offers(product_id,supplier_id,purchase_cost,retail_price,availability,is_active)
                values($1,$2,$3,$4,$5,true)`,[id,supplier.rows[0].id,template.purchase_cost,template.retail_price,template.availability||'check']);
            }
          }
          for (const offer of current.rows) {
            if (['Склад 1','Склад 2'].includes(offer.supplier_name) && !wanted.includes(offer.supplier_name)) {
              await pool.query('update supplier_offers set is_active=false,updated_at=now() where id=$1',[offer.id]);
            }
          }
        }
        await pool.query('insert into audit_log(action,entity_type,entity_id) values($1,$2,$3)',['product.update','product',id]);
        return json(res,200,{message:'Зміни збережено.'});
      }
      if(req.method==='DELETE'&&productMatch){const id=productMatch[1];const client=await pool.connect();try{await client.query('BEGIN');const found=await client.query('select id,name from products where id=$1 for update',[id]);if(!found.rows.length){await client.query('ROLLBACK');return json(res,404,{error:'Товар не найден.'})}const linked=await client.query('select count(*)::int as count from order_items where product_id=$1',[id]);if(linked.rows[0].count>0){await client.query('ROLLBACK');return json(res,409,{error:'Товар уже есть в заказах. Вместо удаления скройте его от покупателей.'})}await client.query('delete from supplier_offers where product_id=$1',[id]);await client.query('delete from products where id=$1',[id]);await client.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)',['product.delete','product',id,JSON.stringify({name:found.rows[0].name})]);await client.query('COMMIT');return json(res,200,{message:'Товар удалён.'})}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}}
      const orderMatch=url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})$/i);
      if(req.method==='PATCH'&&orderMatch){
        const b=await readBody(req), allowed=['new','checking','confirmed','sent_to_supplier','shipped','delivered','cancelled','returned'];
        if(!allowed.includes(b.status))return json(res,400,{error:'Некоректний статус замовлення.'});
        const delivery=b.status==='shipped'?'shipped':b.status==='delivered'?'delivered':b.status==='returned'?'returned':b.status==='cancelled'?'not_shipped':null;
        await pool.query('update orders set status=$1,ttn=coalesce($2,ttn),delivery_status=coalesce($3,delivery_status),updated_at=now() where id=$4',
          [b.status,b.ttn?safeString(b.ttn,80):null,delivery,orderMatch[1]]);
        await pool.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)',['order.update','order',orderMatch[1],JSON.stringify({status:b.status,ttn:b.ttn||null})]);
        return json(res,200,{message:'Замовлення оновлено.'});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/finance'){
        const {rows}=await pool.query(`select count(*) filter(where lower(trim(status)) not in ('cancelled','returned','скасовано','повернення'))::int as orders_count,
          count(*) filter(where lower(trim(status)) not in ('cancelled','returned','скасовано','повернення'))::int as sales_orders_count,
          coalesce(sum(subtotal) filter(where lower(trim(status)) not in ('cancelled','returned','скасовано','повернення')),0)::numeric(12,2) as gross_revenue,
          coalesce(sum(subtotal) filter(where lower(trim(status))='delivered'),0)::numeric(12,2) as delivered_revenue,
          coalesce(sum((select sum(coalesce(i.supplier_cost_snapshot,0)*i.quantity) from order_items i where i.order_id=o.id)) filter(where lower(trim(status)) not in ('cancelled','returned','скасовано','повернення')),0)::numeric(12,2) as estimated_cost
          from orders o`);
        return json(res,200,{finance:rows[0],note:'Операційні витрати не внесені; чистий прибуток не розраховується.'});
      }
      return json(res,404,{error:'Адмін-маршрут не знайдено.'});
    }
    return json(res,404,{error:'Маршрут не знайдено'});
  } catch (error) {
    const status=Number(error.status)||500;
    if(status>=500) console.error('API error:',error.message);
    return json(res,status,{error:status===503?'Базу даних ще не підключено.':status>=500?'Помилка сервера. Спробуйте пізніше.':error.message});
  }
}
http.createServer((req,res)=>{handle(req,res);}).listen(PORT,'0.0.0.0',()=>{ console.log(`VITRANO API listening on ${PORT}`); if(process.env.SIGA_IMPORT_ON_START==='true'){ importSigaCatalog().then(result=>console.log('SIGA_IMPORT_RESULT '+JSON.stringify(result))).catch(error=>console.error('SIGA_IMPORT_FAILED '+error.message)); } });
