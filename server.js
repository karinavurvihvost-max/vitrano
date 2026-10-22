import http from 'node:http';
import pg from 'pg';

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
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
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

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin is not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '600', vary: 'Origin' });
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
      return json(res,200,{hero_banner:rows[0]?.setting_value||{}});
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
          coalesce(rv.average_rating,0)::numeric(2,1) as average_rating,coalesce(rv.review_count,0)::int as review_count,
          case when c.id is null then null else json_build_object('name',c.name,'slug',c.slug) end as categories,
          coalesce(json_agg(json_build_object('id',o.id,'supplier_id',o.supplier_id,'supplier_name',s.name,'retail_price',o.retail_price,'availability',o.availability,'last_checked_at',o.last_checked_at))
            filter (where o.id is not null and o.retail_price is not null), '[]'::json) as offers
        from products p left join categories c on c.id=p.category_id
        left join supplier_offers o on o.product_id=p.id and o.is_active=true
        left join suppliers s on s.id=o.supplier_id and s.is_active=true
        left join (select product_id,avg(rating)::numeric(2,1) as average_rating,count(*)::int as review_count from reviews where status='approved' group by product_id) rv on rv.product_id=p.id
        where ${filters.join(' and ')}
        group by p.id,c.id,rv.average_rating,rv.review_count order by p.name asc limit 100`, params);
      return json(res, 200, { products: rows.filter(p => p.offers.length > 0) });
    }
    const publicReviewMatch=url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/reviews$/i);
    if(publicReviewMatch&&req.method==='GET'){
      requireDb();
      const {rows}=await pool.query("select r.id,r.rating,r.body,r.admin_reply,r.created_at,coalesce(c.full_name,'Покупець') as customer_name from reviews r left join customers c on c.id=r.customer_id where r.product_id=$1 and r.status='approved' order by r.created_at desc limit 50",[publicReviewMatch[1]]);
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
          insert into orders(customer_id,customer_name,customer_phone,carrier,region,city,branch,supplier_id,status,payment_status,delivery_status,subtotal)
          values($1,$2,$3,$4,$5,$6,$7,$8,'new','unpaid','not_shipped',$9)
          returning id,order_number,status,subtotal,created_at`,
          [customerRows[0].id,customer_name,customer_phone,carrier,region,city,branch,offers[0].supplier_id,subtotal]);
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
        const value={
          eyebrow:safeString(b.eyebrow,100),
          title:safeString(b.title,180),
          description:safeString(b.description,500),
          button_text:safeString(b.button_text,60),
          background:['blue','light','dark','purple','green'].includes(b.background)?b.background:'blue',
          image_url:typeof b.image_url==='string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image_url) && b.image_url.length<=1500000 ? b.image_url : ''
        };
        if(!value.title||!value.description||!value.button_text)return json(res,400,{error:'Заповніть заголовок, опис і текст кнопки.'});
        if(typeof b.image_url==='string'&&b.image_url.startsWith('data:image/')&&!value.image_url)return json(res,400,{error:'Фото завелике або формат не підтримується.'});
        await pool.query("insert into storefront_settings(setting_key,setting_value,updated_at) values('hero_banner',$1::jsonb,now()) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now()",[JSON.stringify(value)]);
        await pool.query("insert into audit_log(action,entity_type,details) values($1,$2,$3)",['storefront.banner.update','storefront_settings',JSON.stringify({title:value.title,background:value.background,image_changed:Boolean(value.image_url)})]);
        return json(res,200,{message:'Головний банер збережено.',hero_banner:value});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
        const [p,o,s,fin] = await Promise.all([
          pool.query('select count(*)::int as count from products'),
          pool.query('select count(*)::int as count from orders'),
          pool.query('select count(*)::int as count from suppliers where is_active=true'),
          pool.query("select coalesce(sum(subtotal),0)::numeric(12,2) as revenue from orders where status <> 'cancelled'")
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
        if(!['pending','approved','rejected'].includes(status))return json(res,400,{error:'Некоректний статус відгуку.'});
        await pool.query('update reviews set status=$1,admin_reply=$2 where id=$3',[status,reply||null,reviewAdminMatch[1]]);
        await pool.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)',['review.moderate','review',reviewAdminMatch[1],JSON.stringify({status})]);
        return json(res,200,{message:'Відгук оновлено.'});
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/products') {
        const {rows}=await pool.query(`select p.id,p.sku,p.name,p.slug,p.description,p.characteristics,p.category_id,p.image_urls,p.main_image_url,p.is_visible,c.name as category,c.slug as category_slug,
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
        const price1=b.price_1==null||b.price_1===''?null:Number(b.price_1), price2=b.price_2==null||b.price_2===''?null:Number(b.price_2), cost=b.purchase_cost===''||b.purchase_cost==null?null:Number(b.purchase_cost);
        const warehouses=mode==='both'?['Склад 1','Склад 2']:['Склад 1','Склад 2'].includes(mode)?[mode]:[];
        if(name.length<2||!category||!warehouses.length||(warehouses.includes('Склад 1')&&(!Number.isFinite(price1)||price1<=0))||(warehouses.includes('Склад 2')&&(!Number.isFinite(price2)||price2<=0))||(cost!==null&&(!Number.isFinite(cost)||cost<0))) return json(res,400,{error:'Перевірте назву, склад і ціну для кожного вибраного складу.'});
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
            const price=warehouse==='Склад 1'?price1:price2;
            await client.query('insert into supplier_offers(product_id,supplier_id,purchase_cost,retail_price,availability,is_active) values($1,$2,$3,$4,$5,true)',
              [p.rows[0].id,sup.rows[0].id,cost,price,['available','check','unavailable'].includes(b.availability)?b.availability:'check']);
          }
          await client.query('insert into audit_log(action,entity_type,entity_id,details) values($1,$2,$3,$4)', ['product.create','product',p.rows[0].id,JSON.stringify({name})]);
          await client.query('COMMIT');
          return json(res,201,{id:p.rows[0].id,message:'Товар створено.'});
        } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;} finally{client.release();}
      }
      const productMatch=url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
      if (req.method === 'PATCH' && productMatch) {
        const b=await readBody(req), id=productMatch[1];
        if (b.is_visible!==undefined) await pool.query('update products set is_visible=$1,updated_at=now() where id=$2',[Boolean(b.is_visible),id]);
        if (b.name!==undefined) await pool.query('update products set name=$1,updated_at=now() where id=$2',[safeString(b.name,180),id]);
        if (b.description!==undefined) await pool.query('update products set description=$1,updated_at=now() where id=$2',[safeString(b.description,3000),id]);
        if (b.main_image_url!==undefined) { const img=typeof b.main_image_url==='string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.main_image_url) && b.main_image_url.length<=1500000 ? b.main_image_url : safeString(b.main_image_url,1000); if(typeof img==='string'&&img.startsWith('data:image/')&&img.length>1500000)return json(res,400,{error:'Фото завелике. Виберіть менше фото.'}); await pool.query('update products set main_image_url=$1,updated_at=now() where id=$2',[img||null,id]); }
        if (b.offer_id && (b.retail_price!==undefined||b.purchase_cost!==undefined||b.availability!==undefined)) {
          if (b.retail_price!==undefined && (!Number.isFinite(Number(b.retail_price)) || Number(b.retail_price)<0)) return json(res,400,{error:'Некоректна ціна.'});
          if (b.purchase_cost!==undefined && b.purchase_cost!==null && (!Number.isFinite(Number(b.purchase_cost)) || Number(b.purchase_cost)<0)) return json(res,400,{error:'Некоректна собівартість.'});
          if (b.availability!==undefined && !['available','check','unavailable'].includes(b.availability)) return json(res,400,{error:'Некоректний статус наявності.'});
          await pool.query(
            'update supplier_offers set retail_price=coalesce($1,retail_price), purchase_cost=coalesce($2,purchase_cost), availability=coalesce($3,availability), updated_at=now() where id=$4',
            [b.retail_price===undefined?null:Number(b.retail_price),b.purchase_cost===undefined||b.purchase_cost===null?null:Number(b.purchase_cost),b.availability||null,b.offer_id]
          );
        }
        await pool.query('insert into audit_log(action,entity_type,entity_id) values($1,$2,$3)',['product.update','product',id]);
        return json(res,200,{message:'Зміни збережено.'});
      }
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
        const {rows}=await pool.query(`select count(*)::int as orders_count,coalesce(sum(subtotal) filter(where status<>'cancelled'),0)::numeric(12,2) as gross_revenue,
          coalesce(sum(subtotal) filter(where status='delivered'),0)::numeric(12,2) as delivered_revenue,
          coalesce(sum((select sum(coalesce(i.supplier_cost_snapshot,0)*i.quantity) from order_items i where i.order_id=o.id)) filter(where status<>'cancelled'),0)::numeric(12,2) as estimated_cost
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
http.createServer((req,res)=>{handle(req,res);}).listen(PORT,'0.0.0.0',()=>console.log(`VITRANO API listening on ${PORT}`));
