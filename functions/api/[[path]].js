const DEFAULT_PLACEHOLDER = "https://img.alwandoilpress.com/placeholder.png";
const R2_PUBLIC_BASE = "https://img.alwandoilpress.com";

async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(pin).trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function verifyAgentAuth(request, env) {
  if (!env.AGENT_API_KEY) return true; // Allows testing before key is set
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token === String(env.AGENT_API_KEY).trim();
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: "D1 database binding 'DB' not configured." }, 500);
  }

  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const method = request.method;

  try {
    // 1. GET /api/products
    if (method === "GET" && (path === "products" || path === "getProducts")) {
      const query = `
        SELECT 
          p.id AS product_id,
          p.category,
          p.name_ar,
          p.name_ku,
          p.name_en,
          p.description_ar,
          p.description_ku,
          p.description_en,
          p.main_image_url,
          p.is_bundle,
          p.bundle_items_json,
          v.id AS variant_id,
          v.size_label,
          v.price_iqd,
          v.cost_iqd,
          v.wholesale_price_iqd,
          v.discount_percent,
          v.barcode,
          v.in_stock,
          v.stock_quantity,
          v.image_url AS specific_image_url,
          COALESCE(v.image_url, p.main_image_url, ?) AS display_image
        FROM products p
        LEFT JOIN product_variants v ON p.id = v.product_id
        WHERE p.is_active = 1
        ORDER BY p.id ASC, v.sort_order ASC;
      `;

      const { results } = await db.prepare(query).bind(DEFAULT_PLACEHOLDER).all();
      const catalogMap = new Map();

      for (const row of results) {
        if (!catalogMap.has(row.product_id)) {
          let bundleItems = [];
          try { bundleItems = JSON.parse(row.bundle_items_json || "[]"); } catch(e){}

          catalogMap.set(row.product_id, {
            id: row.product_id,
            category: row.category,
            name_ar: row.name_ar,
            name_ku: row.name_ku,
            name_en: row.name_en,
            description_ar: row.description_ar,
            description_ku: row.description_ku,
            description_en: row.description_en,
            main_image_url: row.main_image_url || DEFAULT_PLACEHOLDER,
            is_bundle: Boolean(row.is_bundle),
            bundle_items: bundleItems,
            variants: []
          });
        }

        if (row.variant_id) {
          catalogMap.get(row.product_id).variants.push({
            variant_id: row.variant_id,
            size_label: row.size_label,
            price_iqd: row.price_iqd,
            cost_iqd: row.cost_iqd || 0,
            wholesale_price_iqd: row.wholesale_price_iqd || row.price_iqd,
            discount_percent: row.discount_percent || 0,
            barcode: row.barcode || "",
            in_stock: Boolean(row.in_stock),
            stock_quantity: row.stock_quantity,
            specific_image_url: row.specific_image_url || "",
            image_url: row.display_image
          });
        }
      }

      return jsonResponse({ products: Array.from(catalogMap.values()) });
    }

    // 2. GET /api/zones
    if (method === "GET" && path === "zones") {
      const { results } = await db.prepare(
        "SELECT id, name_ar, name_ku, name_en, fee_iqd FROM delivery_zones WHERE is_active = 1 ORDER BY fee_iqd ASC"
      ).all();
      return jsonResponse({ zones: results });
    }

    // 3. POST /api/auth (Username + PIN)
    if (method === "POST" && path === "auth") {
      const body = await request.json();
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "").trim();

      if (!name || !pin) {
        return jsonResponse({ error: "اسم المستخدم ورمز PIN مطلوبان" }, 400);
      }

      const inputHash = await hashPin(pin);
      const staffMember = await db.prepare(
        "SELECT id, name, role, permissions FROM staff WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND pin_hash = ? AND is_active = 1"
      ).bind(name, inputHash).first();

      if (!staffMember) {
        return jsonResponse({ error: "اسم المستخدم أو الرمز السري غير صحيح" }, 401);
      }

      let perms = [];
      try {
        perms = JSON.parse(staffMember.permissions || "[]");
      } catch (e) {
        perms = [];
      }

      return jsonResponse({
        success: true,
        staff: {
          id: staffMember.id,
          name: staffMember.name,
          role: String(staffMember.role || "cashier").toLowerCase(),
          permissions: perms
        }
      });
    }

    // 3.5 GET /api/orders/track (Public Storefront & Agent Order Lookup)
    if (method === "GET" && path === "orders/track") {
      const url = new URL(request.url);
      const rawQuery = String(url.searchParams.get("q") || "").trim();

      if (rawQuery.length < 4) {
        return jsonResponse({ error: "يرجى إدخال رقم الطلب أو رقم الهاتف بشكل صحيح" }, 400);
      }

      const cleanPhone = rawQuery.replace(/[\s\-]/g, "");

      const query = `
        SELECT 
          o.id,
          o.order_number,
          o.channel,
          o.status,
          o.created_at,
          o.subtotal_iqd,
          o.delivery_fee_iqd,
          o.discount_iqd,
          o.total_iqd,
          o.customer_name,
          json_group_array(
            json_object(
              'item_id', oi.id,
              'product_name', oi.product_name_ar,
              'size', oi.size_label,
              'unit_price', oi.unit_price_iqd,
              'quantity', oi.quantity,
              'line_total', oi.line_total_iqd
            )
          ) AS items_json
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE UPPER(TRIM(o.order_number)) = UPPER(?)
           OR REPLACE(REPLACE(TRIM(COALESCE(o.customer_phone, '')), ' ', ''), '-', '') = ?
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 5;
      `;

      const { results } = await db.prepare(query).bind(rawQuery, cleanPhone).all();

      const orders = results.map(row => {
        let items = [];
        try {
          items = JSON.parse(row.items_json || "[]").filter(i => i.item_id !== null);
        } catch (e) {}

        return {
          order_number: row.order_number,
          channel: row.channel,
          status: row.status,
          created_at: row.created_at,
          subtotal_iqd: row.subtotal_iqd,
          delivery_fee_iqd: row.delivery_fee_iqd,
          discount_iqd: row.discount_iqd,
          total_iqd: row.total_iqd,
          customer_name: row.customer_name || "",
          items
        };
      });

      return jsonResponse({ orders });
    }
    
    // 4. GET /api/orders/list
    if (method === "GET" && path === "orders/list") {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const search = url.searchParams.get("search") || "";

      let query = `
        SELECT 
          o.id, o.order_number, o.channel, o.status, o.created_at,
          o.subtotal_iqd, o.delivery_fee_iqd, o.discount_iqd, o.total_iqd,
          o.payment_method, o.customer_name, o.customer_phone, o.address, o.notes,
          s.name AS cashier_name,
          json_group_array(
            json_object(
              'item_id', oi.id,
              'variant_id', oi.variant_id,
              'product_name', oi.product_name_ar,
              'size', oi.size_label,
              'unit_price', oi.unit_price_iqd,
              'quantity', oi.quantity,
              'line_total', oi.line_total_iqd
            )
          ) AS items_json
        FROM orders o
        LEFT JOIN staff s ON o.staff_id = s.id
        LEFT JOIN order_items oi ON o.id = oi.order_id
      `;

      const binds = [];
      if (search) {
        query += ` WHERE o.order_number LIKE ? OR o.customer_phone LIKE ? `;
        binds.push(`%${search}%`, `%${search}%`);
      }

      query += ` GROUP BY o.id ORDER BY o.created_at DESC LIMIT ?;`;
      binds.push(limit);

      const { results } = await db.prepare(query).bind(...binds).all();

      const orders = results.map(row => {
        let items = [];
        try { items = JSON.parse(row.items_json || "[]").filter(i => i.item_id !== null); } catch(e){}
        return {
          ...row,
          items: items
        };
      });

      return jsonResponse({ orders });
    }

    // 5. POST /api/orders/return
    if (method === "POST" && path === "orders/return") {
      const body = await request.json();
      const { order_id, order_number, returned_items, customer_phone, customer_name, return_reason } = body;

      if (!order_id && !order_number) {
        return jsonResponse({ error: "Order ID or Number is required" }, 400);
      }

      if (!customer_phone) {
        return jsonResponse({ error: "رقم هاتف الزبون مطلوب لإتمام عملية الإرجاع" }, 400);
      }

      const order = await db.prepare(
        "SELECT id, order_number, status, total_iqd FROM orders WHERE id = ? OR order_number = ?"
      ).bind(order_id || null, order_number || null).first();

      if (!order) {
        return jsonResponse({ error: "لم يتم العثور على الفاتورة" }, 404);
      }

      if (order.status === "cancelled") {
        return jsonResponse({ error: "تم إرجاع هذه الفاتورة بالكامل مسبقاً" }, 400);
      }

      const batchStatements = [];

      if (Array.isArray(returned_items) && returned_items.length > 0) {
        for (const item of returned_items) {
          if (item.variant_id && item.quantity > 0) {
            batchStatements.push(
              db.prepare(
                "UPDATE product_variants SET stock_quantity = COALESCE(stock_quantity, 0) + ? WHERE id = ?"
              ).bind(Number(item.quantity), item.variant_id)
            );
          }
        }
      }

      const returnNotes = `[مرتجع: ${return_reason || 'طلب زبون'} | هاتف: ${customer_phone}${customer_name ? ' | اسم: ' + customer_name : ''}]`;
      batchStatements.push(
        db.prepare(`
          UPDATE orders 
          SET status = 'cancelled',
              notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' ' || ? END
          WHERE id = ?
        `).bind(returnNotes, returnNotes, order.id)
      );

      batchStatements.push(
        db.prepare(`
          INSERT INTO customers (phone, name, notes, total_spent_iqd, orders_count)
          VALUES (?, ?, ?, 0, 0)
          ON CONFLICT(phone) DO UPDATE SET
            notes = COALESCE(customers.notes, '') || ' ' || excluded.notes,
            total_spent_iqd = MAX(0, customers.total_spent_iqd - ?),
            updated_at = CURRENT_TIMESTAMP
        `).bind(customer_phone, customer_name || "زبون مرتجع", returnNotes, Number(order.total_iqd || 0))
      );

      await db.batch(batchStatements);

      return jsonResponse({ success: true, message: "تم تسجيل الإرجاع واستعادة المخزون بنجاح" });
    }

    // 6. POST /api/orders/edit
    if (method === "POST" && path === "orders/edit") {
      const body = await request.json();
      const { order_id, payment_method, notes, customer_name, customer_phone, address } = body;

      if (!order_id) {
        return jsonResponse({ error: "Order ID is required" }, 400);
      }

      await db.prepare(`
        UPDATE orders
        SET payment_method = COALESCE(?, payment_method),
            notes = COALESCE(?, notes),
            customer_name = COALESCE(?, customer_name),
            customer_phone = COALESCE(?, customer_phone),
            address = COALESCE(?, address)
        WHERE id = ?
      `).bind(payment_method || null, notes || null, customer_name || null, customer_phone || null, address || null, order_id).run();

      return jsonResponse({ success: true });
    }

    // 7. GET & POST /api/customers
    if (method === "GET" && path === "customers") {
      const url = new URL(request.url);
      const phone = url.searchParams.get("phone");

      if (!phone) {
        return jsonResponse({ error: "Phone number required" }, 400);
      }

      const customer = await db.prepare(
        "SELECT phone, name, default_address, notes, total_spent_iqd, orders_count FROM customers WHERE phone = ?"
      ).bind(phone).first();

      if (!customer) {
        return jsonResponse({ found: false });
      }

      const addresses = await db.prepare(
        "SELECT address, landmark, last_used_at FROM customer_addresses WHERE customer_phone = ? ORDER BY last_used_at DESC"
      ).bind(phone).all();

      const pastOrders = await db.prepare(`
        SELECT o.order_number, o.created_at, o.channel, o.status, o.total_iqd, 
               json_group_array(json_object('product_name', oi.product_name_ar, 'size', oi.size_label, 'qty', oi.quantity, 'price', oi.unit_price_iqd)) AS items_json
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE o.customer_phone = ?
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 10
      `).bind(phone).all();

      return jsonResponse({
        found: true,
        customer: customer,
        addresses: addresses.results || [],
        orders: (pastOrders.results || []).map(o => ({
          ...o,
          items: JSON.parse(o.items_json || "[]")
        }))
      });
    }

    if (method === "POST" && path === "customers") {
      const body = await request.json();
      const { phone, name, address, notes, landmark } = body;

      if (!phone) {
        return jsonResponse({ error: "Phone number is required" }, 400);
      }

      await db.prepare(`
        INSERT INTO customers (phone, name, default_address, notes, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(phone) DO UPDATE SET
          name = COALESCE(excluded.name, customers.name),
          default_address = COALESCE(excluded.default_address, customers.default_address),
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `).bind(phone, name || "زبون", address || null, notes || "").run();

      if (address) {
        await db.prepare(`
          INSERT INTO customer_addresses (customer_phone, address, landmark, last_used_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(phone, address, landmark || "").run();
      }

      return jsonResponse({ success: true });
    }

    // 8. POST /api/orders (Safe transaction handling + Instant n8n Web Order Push)
    if (method === "POST" && (path === "orders" || path === "submitOrder")) {
      const body = await request.json();
      const items = body.items || [];

      if (!items.length) {
        return jsonResponse({ error: "سلة المشتريات فارغة" }, 400);
      }

      const isDelivery = body.channel === "delivery";
      const channel = body.channel === "web" ? "web" : "pos";
      const orderNotes = isDelivery 
        ? `[طلب توصيل] ${body.notes || ""}`.trim() 
        : (body.notes || null);

      const datePrefix = new Date().toISOString().slice(2, 7).replace("-", "");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderNumber = `${(isDelivery ? "DEL" : channel).toUpperCase()}-${datePrefix}-${randomSuffix}`;

      let subtotal = 0;
      for (const item of items) {
        subtotal += (Number(item.unit_price_iqd) || 0) * (Number(item.quantity) || 1);
      }

      const deliveryFee = Number(body.delivery_fee_iqd) || 0;
      const discount = Number(body.discount_iqd) || 0;
      const total = Math.max(0, subtotal + deliveryFee - discount);

      const cashTendered = body.cash_tendered_iqd !== undefined && body.cash_tendered_iqd !== null ? Number(body.cash_tendered_iqd) : total;
      const changeDue = Math.max(0, cashTendered - total);

      await db.prepare(`
        INSERT INTO orders (
          order_number, channel, status, staff_id,
          subtotal_iqd, delivery_fee_iqd, discount_iqd, total_iqd,
          payment_method, cash_tendered_iqd, change_due_iqd,
          customer_name, customer_phone, zone_id, address, landmark, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        orderNumber,
        channel,
        channel === "web" ? "pending" : "completed",
        body.staff_id || null,
        subtotal,
        deliveryFee,
        discount,
        total,
        body.payment_method || "cash",
        cashTendered,
        changeDue,
        body.customer_name || null,
        body.customer_phone || null,
        null,
        body.address || null,
        body.landmark || null,
        orderNotes
      ).run();

      const orderRecord = await db.prepare("SELECT id FROM orders WHERE order_number = ?").bind(orderNumber).first();
      const newOrderId = orderRecord.id;

      const batchStatements = [];

      for (const item of items) {
        const lineTotal = (Number(item.unit_price_iqd) || 0) * (Number(item.quantity) || 1);
        batchStatements.push(
          db.prepare(`
            INSERT INTO order_items (
              order_id, variant_id, product_name_ar, size_label,
              unit_price_iqd, quantity, line_total_iqd
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            newOrderId,
            item.variant_id || null,
            item.product_name_ar,
            item.size_label,
            Number(item.unit_price_iqd) || 0,
            Number(item.quantity) || 1,
            lineTotal
          )
        );

        if (item.variant_id) {
          batchStatements.push(
            db.prepare(`
              UPDATE product_variants 
              SET stock_quantity = MAX(0, COALESCE(stock_quantity, 0) - ?) 
              WHERE id = ? AND stock_quantity IS NOT NULL
            `).bind(Number(item.quantity) || 1, item.variant_id)
          );
        }
      }

      if (body.customer_phone) {
        batchStatements.push(
          db.prepare(`
            INSERT INTO customers (phone, name, default_address, total_spent_iqd, orders_count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(phone) DO UPDATE SET
              total_spent_iqd = customers.total_spent_iqd + excluded.total_spent_iqd,
              orders_count = customers.orders_count + 1,
              name = COALESCE(excluded.name, customers.name),
              default_address = COALESCE(excluded.default_address, customers.default_address),
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            body.customer_phone,
            body.customer_name || "زبون",
            body.address || null,
            total
          )
        );

        if (body.address) {
          batchStatements.push(
            db.prepare(`
              INSERT INTO customer_addresses (customer_phone, address, landmark, last_used_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `).bind(body.customer_phone, body.address, body.landmark || "")
          );
        }
      }

      if (batchStatements.length > 0) {
        await db.batch(batchStatements);
      }

      // Non-blocking alert push to n8n when a web/social order is created
      if (channel === "web" && env.N8N_ORDER_WEBHOOK_URL) {
        const alertPromise = fetch(env.N8N_ORDER_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.AGENT_API_KEY ? { "Authorization": `Bearer ${env.AGENT_API_KEY}` } : {})
          },
          body: JSON.stringify({
            event: "new_web_order",
            order_number: orderNumber,
            customer_name: body.customer_name || "",
            customer_phone: body.customer_phone || "",
            address: body.address || "",
            landmark: body.landmark || "",
            subtotal_iqd: subtotal,
            delivery_fee_iqd: deliveryFee,
            discount_iqd: discount,
            total_iqd: total,
            notes: orderNotes || "",
            items: items
          })
        }).catch(() => {});
        if (context.waitUntil) {
          context.waitUntil(alertPromise);
        }
      }

      return jsonResponse({
        success: true,
        order_number: orderNumber,
        total_iqd: total,
        change_due_iqd: changeDue
      });
    }

    // 8.5 POST /api/manage/upload (Direct R2 Image/Media Upload)
    if (method === "POST" && path === "manage/upload") {
      if (!env.IMAGES_BUCKET) {
        return jsonResponse({ error: "R2 binding 'IMAGES_BUCKET' is not configured." }, 500);
      }

      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        return jsonResponse({ error: "لم يتم اختيار ملف" }, 400);
      }

      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "video/mp4"];
      if (!allowedTypes.includes(file.type)) {
        return jsonResponse({ error: "صيغة الملف غير مدعومة" }, 400);
      }

      if (file.size > 25 * 1024 * 1024) {
        return jsonResponse({ error: "حجم الملف يتجاوز الحد المسموح (25MB)" }, 400);
      }

      const extMap = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/avif": "avif",
        "video/mp4": "mp4"
      };
      const ext = extMap[file.type] || "webp";
      const folder = file.type.startsWith("video/") ? "videos" : "products";
      const randomPart = Math.random().toString(36).substring(2, 8);
      const objectKey = `${folder}/${Date.now()}-${randomPart}.${ext}`;

      await env.IMAGES_BUCKET.put(objectKey, await file.arrayBuffer(), {
        httpMetadata: {
          contentType: file.type,
          cacheControl: "public, max-age=31536000, immutable"
        }
      });

      return jsonResponse({
        success: true,
        key: objectKey,
        url: `${R2_PUBLIC_BASE}/${objectKey}`
      });
    }
    
    // 9. Product & Variants Management
    if (method === "POST" && path === "manage/product") {
      const body = await request.json();
      const { id, category, name_ar, name_ku, name_en, description_ar, main_image_url, is_bundle, bundle_items, variants } = body;

      if (!name_ar || !category) {
        return jsonResponse({ error: "اسم المنتج والتصنيف مطلوبان" }, 400);
      }

      let productId = id;
      const bundleJson = JSON.stringify(bundle_items || []);

      if (productId) {
        await db.prepare(`
          UPDATE products 
          SET category = ?, name_ar = ?, name_ku = ?, name_en = ?, description_ar = ?, main_image_url = ?, is_bundle = ?, bundle_items_json = ?
          WHERE id = ?
        `).bind(category, name_ar, name_ku || null, name_en || null, description_ar || null, main_image_url || null, is_bundle ? 1 : 0, bundleJson, productId).run();
      } else {
        const insertRes = await db.prepare(`
          INSERT INTO products (category, name_ar, name_ku, name_en, description_ar, main_image_url, is_bundle, bundle_items_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(category, name_ar, name_ku || null, name_en || null, description_ar || null, main_image_url || null, is_bundle ? 1 : 0, bundleJson).run();
        productId = insertRes.meta.last_row_id;
      }

      if (Array.isArray(variants)) {
        for (const v of variants) {
          if (v.variant_id) {
            await db.prepare(`
              UPDATE product_variants
              SET size_label = ?, price_iqd = ?, cost_iqd = ?, wholesale_price_iqd = ?, discount_percent = ?,
                  barcode = ?, stock_quantity = ?, in_stock = ?, image_url = ?
              WHERE id = ?
            `).bind(
              v.size_label,
              Number(v.price_iqd),
              Number(v.cost_iqd || 0),
              Number(v.wholesale_price_iqd || v.price_iqd),
              Number(v.discount_percent || 0),
              v.barcode || null,
              v.stock_quantity !== null && v.stock_quantity !== "" ? Number(v.stock_quantity) : null,
              v.in_stock ? 1 : 0,
              v.image_url || null,
              v.variant_id
            ).run();
          } else if (v.size_label) {
            await db.prepare(`
              INSERT INTO product_variants (
                product_id, size_label, price_iqd, cost_iqd, wholesale_price_iqd, discount_percent,
                barcode, stock_quantity, in_stock, image_url
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              productId,
              v.size_label,
              Number(v.price_iqd || 0),
              Number(v.cost_iqd || 0),
              Number(v.wholesale_price_iqd || v.price_iqd || 0),
              Number(v.discount_percent || 0),
              v.barcode || null,
              v.stock_quantity !== null && v.stock_quantity !== "" ? Number(v.stock_quantity) : null,
              v.in_stock ? 1 : 0,
              v.image_url || null
            ).run();
          }
        }
      }

      return jsonResponse({ success: true, product_id: productId });
    }

    // 9.5 POST /api/manage/product/delete
    if (method === "POST" && path === "manage/product/delete") {
      const body = await request.json();
      const productId = body.id;

      if (!productId) {
        return jsonResponse({ error: "معرف المنتج مطلوب" }, 400);
      }

      await db.prepare("UPDATE products SET is_active = 0 WHERE id = ?")
        .bind(productId)
        .run();

      return jsonResponse({ success: true });
    }
    
    // 10. Reports Summary
    if (method === "GET" && path === "reports") {
      const url = new URL(request.url);
      const startDate = url.searchParams.get("start") || "1970-01-01";
      const endDate = url.searchParams.get("end") || "2099-12-31";

      const summaryQuery = `
        SELECT 
          COUNT(id) AS total_orders,
          COALESCE(SUM(total_iqd), 0) AS total_sales_iqd,
          COALESCE(SUM(discount_iqd), 0) AS total_discounts_iqd
        FROM orders
        WHERE DATE(created_at) >= DATE(?) AND DATE(created_at) <= DATE(?) AND status = 'completed';
      `;
      const summary = await db.prepare(summaryQuery).bind(startDate, endDate).first();

      const cogsQuery = `
        SELECT 
          COALESCE(SUM(oi.quantity * COALESCE(pv.cost_iqd, 0)), 0) AS total_cogs_iqd
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN product_variants pv ON oi.variant_id = pv.id
        WHERE DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) <= DATE(?) AND o.status = 'completed';
      `;
      const cogsRow = await db.prepare(cogsQuery).bind(startDate, endDate).first();

      const sales = Number(summary.total_sales_iqd || 0);
      const cogs = Number(cogsRow.total_cogs_iqd || 0);
      const netProfit = sales - cogs;

      return jsonResponse({
        summary: {
          orders_count: summary.total_orders,
          gross_sales_iqd: sales,
          total_cogs_iqd: cogs,
          net_profit_iqd: netProfit,
          profit_margin_percent: sales > 0 ? ((netProfit / sales) * 100).toFixed(1) : 0
        }
      });
    }

    // 11. Staff Management
    if (method === "GET" && path === "staff") {
      const { results } = await db.prepare(
        "SELECT id, name, role, permissions, is_active FROM staff ORDER BY id ASC"
      ).all();
      return jsonResponse({
        staff: results.map(s => {
          let perms = [];
          try { perms = JSON.parse(s.permissions || "[]"); } catch(e){}
          return {
            ...s,
            permissions: perms
          };
        })
      });
    }

    if (method === "POST" && path === "staff") {
      const body = await request.json();
      const { id, name, pin, role, permissions, is_active } = body;

      if (!name) {
        return jsonResponse({ error: "اسم الموظف مطلوب" }, 400);
      }

      const cleanRole = String(role || "cashier").toLowerCase();
      const permsJson = JSON.stringify(permissions || []);

      if (id) {
        if (pin && String(pin).trim() !== "") {
          const pinH = await hashPin(pin);
          await db.prepare(
            "UPDATE staff SET name = ?, pin_hash = ?, role = ?, permissions = ?, is_active = ? WHERE id = ?"
          ).bind(name, pinH, cleanRole, permsJson, is_active !== false ? 1 : 0, id).run();
        } else {
          await db.prepare(
            "UPDATE staff SET name = ?, role = ?, permissions = ?, is_active = ? WHERE id = ?"
          ).bind(name, cleanRole, permsJson, is_active !== false ? 1 : 0, id).run();
        }
      } else {
        if (!pin) {
          return jsonResponse({ error: "رمز PIN مطلوب للموظف الجديد" }, 400);
        }
        const pinH = await hashPin(pin);
        await db.prepare(
          "INSERT INTO staff (name, pin_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, 1)"
        ).bind(name, pinH, cleanRole, permsJson).run();
      }

      return jsonResponse({ success: true });
    }

    // ==================== 12. AI AGENT ENDPOINTS (/api/agent/*) ====================
    if (path.startsWith("agent/")) {
      if (!verifyAgentAuth(request, env)) {
        return jsonResponse({ error: "Unauthorized Agent Request" }, 401);
      }

      // 12.1 GET /api/agent/customer-context
      if (method === "GET" && path === "agent/customer-context") {
        const url = new URL(request.url);
        const phone = String(url.searchParams.get("phone") || "").replace(/[\s\-]/g, "");
        const platform = String(url.searchParams.get("platform") || "").trim();
        const userId = String(url.searchParams.get("user_id") || "").trim();

        let lead = null;
        if (platform && userId) {
          lead = await db.prepare(
            "SELECT * FROM social_leads WHERE platform = ? AND platform_user_id = ?"
          ).bind(platform, userId).first();
        } else if (phone) {
          lead = await db.prepare(
            "SELECT * FROM social_leads WHERE phone = ? ORDER BY updated_at DESC LIMIT 1"
          ).bind(phone).first();
        }

        const resolvedPhone = phone || (lead && lead.phone) || "";
        let customer = null;
        let addresses = [];
        let pastOrders = [];

        if (resolvedPhone) {
          customer = await db.prepare(
            "SELECT phone, name, default_address, notes, total_spent_iqd, orders_count FROM customers WHERE phone = ?"
          ).bind(resolvedPhone).first();

          const addrRes = await db.prepare(
            "SELECT address, landmark, last_used_at FROM customer_addresses WHERE customer_phone = ? ORDER BY last_used_at DESC LIMIT 5"
          ).bind(resolvedPhone).all();
          addresses = addrRes.results || [];

          const ordRes = await db.prepare(`
            SELECT o.order_number, o.channel, o.status, o.total_iqd, o.created_at,
                   json_group_array(json_object('product', oi.product_name_ar, 'size', oi.size_label, 'qty', oi.quantity)) AS items_json
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            WHERE o.customer_phone = ?
            GROUP BY o.id
            ORDER BY o.created_at DESC
            LIMIT 10
          `).bind(resolvedPhone).all();

          pastOrders = (ordRes.results || []).map(o => ({
            order_number: o.order_number,
            channel: o.channel,
            status: o.status,
            total_iqd: o.total_iqd,
            created_at: o.created_at,
            items: JSON.parse(o.items_json || "[]")
          }));
        }

        return jsonResponse({
          known_customer: Boolean(customer),
          customer,
          addresses,
          past_orders: pastOrders,
          social_lead: lead
        });
      }

      // 12.2 POST /api/agent/social-lead
      if (method === "POST" && path === "agent/social-lead") {
        const body = await request.json();
        const { platform, platform_user_id, username, phone, interested_products, lead_stage, last_message_summary } = body;

        if (!platform || !platform_user_id) {
          return jsonResponse({ error: "platform and platform_user_id are required" }, 400);
        }

        const cleanPhone = phone ? String(phone).replace(/[\s\-]/g, "") : null;

        await db.prepare(`
          INSERT INTO social_leads (platform, platform_user_id, username, phone, interested_products, lead_stage, last_message_summary, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(platform, platform_user_id) DO UPDATE SET
            username = COALESCE(excluded.username, social_leads.username),
            phone = COALESCE(excluded.phone, social_leads.phone),
            interested_products = COALESCE(excluded.interested_products, social_leads.interested_products),
            lead_stage = COALESCE(excluded.lead_stage, social_leads.lead_stage),
            last_message_summary = COALESCE(excluded.last_message_summary, social_leads.last_message_summary),
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          platform,
          String(platform_user_id),
          username || null,
          cleanPhone,
          interested_products || null,
          lead_stage || "inquiry",
          last_message_summary || null
        ).run();

        if (cleanPhone) {
          await db.prepare(`
            INSERT INTO customers (phone, name, notes, total_spent_iqd, orders_count)
            VALUES (?, ?, ?, 0, 0)
            ON CONFLICT(phone) DO UPDATE SET
              name = COALESCE(excluded.name, customers.name)
          `).bind(cleanPhone, username || "زبون سوشيال", `[${platform}] ${last_message_summary || ""}`).run();
        }

        return jsonResponse({ success: true });
      }

      // 12.3 GET /api/agent/analytics (Unified POS + Web + Leads + Media + Market Intel)
      if (method === "GET" && path === "agent/analytics") {
        const topProducts = await db.prepare(`
          SELECT oi.product_name_ar, oi.size_label, o.channel,
                 SUM(oi.quantity) AS units_sold,
                 SUM(oi.line_total_iqd) AS revenue_iqd
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE o.status != 'cancelled' AND o.created_at >= datetime('now', '-30 days')
          GROUP BY oi.product_name_ar, oi.size_label, o.channel
          ORDER BY units_sold DESC
          LIMIT 25
        `).all();

        const lowStock = await db.prepare(`
          SELECT p.id AS product_id, p.name_ar, p.category, v.id AS variant_id, v.size_label, v.stock_quantity, v.in_stock
          FROM product_variants v
          JOIN products p ON v.product_id = p.id
          WHERE p.is_active = 1 AND (v.in_stock = 0 OR (v.stock_quantity IS NOT NULL AND v.stock_quantity <= 5))
          ORDER BY v.stock_quantity ASC
        `).all();

        const recentLeads = await db.prepare(`
          SELECT platform, username, phone, interested_products, lead_stage, last_message_summary, updated_at
          FROM social_leads
          ORDER BY updated_at DESC
          LIMIT 25
        `).all();

        const recentIntel = await db.prepare(`
          SELECT id, source, competitor_or_topic, summary, actionable_opportunity, captured_at
          FROM market_intel
          ORDER BY captured_at DESC
          LIMIT 20
        `).all();

        const unpostedMedia = await db.prepare(`
          SELECT id, r2_key, public_url, media_type, product_id, gemini_description, quality_score, times_published, last_published_at
          FROM media_assets
          ORDER BY times_published ASC, quality_score DESC, created_at DESC
          LIMIT 20
        `).all();

        return jsonResponse({
          top_products_30d: topProducts.results || [],
          low_or_out_of_stock: lowStock.results || [],
          recent_social_leads: recentLeads.results || [],
          recent_market_intel: recentIntel.results || [],
          available_media_assets: unpostedMedia.results || []
        });
      }

      // 12.4 POST /api/agent/intel
      if (method === "POST" && path === "agent/intel") {
        const body = await request.json();
        const { source, competitor_or_topic, summary, actionable_opportunity } = body;

        if (!summary) {
          return jsonResponse({ error: "summary is required" }, 400);
        }

        await db.prepare(`
          INSERT INTO market_intel (source, competitor_or_topic, summary, actionable_opportunity)
          VALUES (?, ?, ?, ?)
        `).bind(
          source || "web_trend",
          competitor_or_topic || null,
          summary,
          actionable_opportunity || null
        ).run();

        return jsonResponse({ success: true });
      }

      // 12.5 POST /api/agent/media (Register new media or mark published)
      if (method === "POST" && path === "agent/media") {
        const body = await request.json();

        if (body.action === "mark_published" && body.media_id) {
          await db.prepare(`
            UPDATE media_assets
            SET times_published = times_published + 1,
                last_published_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(body.media_id).run();
          return jsonResponse({ success: true });
        }

        const { r2_key, public_url, media_type, product_id, gemini_description, quality_score } = body;
        if (!public_url) {
          return jsonResponse({ error: "public_url is required" }, 400);
        }

        const res = await db.prepare(`
          INSERT INTO media_assets (r2_key, public_url, media_type, product_id, gemini_description, quality_score)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          r2_key || "",
          public_url,
          media_type || "image",
          product_id || null,
          gemini_description || "",
          Number(quality_score) || 7
        ).run();

        return jsonResponse({ success: true, media_id: res.meta.last_row_id });
      }
    }

    return jsonResponse({ error: `Route '/api/${path}' not found` }, 404);
  } catch (err) {
    return jsonResponse({ error: "Internal Server Error", message: err.message }, 500);
  }
}
