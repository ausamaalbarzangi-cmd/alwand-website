const DEFAULT_PLACEHOLDER = "https://img.alwandoilpress.com/placeholder.png";

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
          v.id AS variant_id,
          v.size_label,
          v.price_iqd,
          v.cost_iqd,
          v.wholesale_price_iqd,
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

    if (method === "GET" && path === "zones") {
      const { results } = await db.prepare(
        "SELECT id, name_ar, name_ku, name_en, fee_iqd FROM delivery_zones WHERE is_active = 1 ORDER BY fee_iqd ASC"
      ).all();
      return jsonResponse({ zones: results });
    }

    if (method === "POST" && path === "auth") {
      const body = await request.json();
      const pin = body.pin;

      if (!pin) {
        return jsonResponse({ error: "PIN is required" }, 400);
      }

      const inputHash = await hashPin(pin);
      const staffMember = await db.prepare(
        "SELECT id, name, role, permissions FROM staff WHERE pin_hash = ? AND is_active = 1"
      ).bind(inputHash).first();

      if (!staffMember) {
        return jsonResponse({ error: "رمز الدخول غير صحيح" }, 401);
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
          role: staffMember.role,
          permissions: perms
        }
      });
    }

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
        SELECT o.order_number, o.created_at, o.channel, o.total_iqd, 
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
      const { phone, name, address, notes } = body;

      if (!phone || !name) {
        return jsonResponse({ error: "Phone and Name are required" }, 400);
      }

      await db.prepare(`
        INSERT INTO customers (phone, name, default_address, notes, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(phone) DO UPDATE SET
          name = excluded.name,
          default_address = COALESCE(excluded.default_address, customers.default_address),
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `).bind(phone, name, address || null, notes || "").run();

      if (address) {
        await db.prepare(`
          INSERT INTO customer_addresses (customer_phone, address, landmark, last_used_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(phone, address, body.landmark || "").run();
      }

      return jsonResponse({ success: true });
    }

    if (method === "POST" && (path === "orders" || path === "submitOrder")) {
      const body = await request.json();
      const channel = body.channel || (body.orderId ? "web" : "pos");
      const items = body.items || [];

      if (!items.length) {
        return jsonResponse({ error: "Order items list is empty" }, 400);
      }

      const datePrefix = new Date().toISOString().slice(2, 7).replace("-", "");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderNumber = `${channel.toUpperCase()}-${datePrefix}-${randomSuffix}`;

      let subtotal = 0;
      for (const item of items) {
        subtotal += Number(item.unit_price_iqd) * Number(item.quantity);
      }

      const deliveryFee = Number(body.delivery_fee_iqd) || 0;
      const discount = Number(body.discount_iqd) || 0;
      const total = subtotal + deliveryFee - discount;

      const cashTendered = body.cash_tendered_iqd !== undefined && body.cash_tendered_iqd !== null ? Number(body.cash_tendered_iqd) : null;
      const changeDue = cashTendered !== null ? Math.max(0, cashTendered - total) : null;

      const orderResult = await db.prepare(`
        INSERT INTO orders (
          order_number, channel, status, staff_id,
          subtotal_iqd, delivery_fee_iqd, discount_iqd, total_iqd,
          payment_method, cash_tendered_iqd, change_due_iqd,
          customer_name, customer_phone, zone_id, address, landmark, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        orderNumber,
        channel,
        channel === "pos" ? "completed" : "pending",
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
        body.zone_id || null,
        body.address || null,
        body.landmark || null,
        body.notes || null
      ).run();

      const newOrderId = orderResult.meta.last_row_id;
      const batchStatements = [];

      for (const item of items) {
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
            item.unit_price_iqd,
            item.quantity,
            item.unit_price_iqd * item.quantity
          )
        );

        if (item.variant_id) {
          batchStatements.push(
            db.prepare(`
              UPDATE product_variants 
              SET stock_quantity = MAX(0, stock_quantity - ?) 
              WHERE id = ? AND stock_quantity IS NOT NULL
            `).bind(item.quantity, item.variant_id)
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

      await db.batch(batchStatements);

      return jsonResponse({
        success: true,
        order_number: orderNumber,
        total_iqd: total,
        change_due_iqd: changeDue
      });
    }

    if (method === "POST" && path === "manage/product") {
      const body = await request.json();
      const { id, category, name_ar, name_ku, name_en, description_ar, main_image_url, variants } = body;

      if (!name_ar || !category) {
        return jsonResponse({ error: "Product name and category are required" }, 400);
      }

      let productId = id;

      if (productId) {
        await db.prepare(`
          UPDATE products 
          SET category = ?, name_ar = ?, name_ku = ?, name_en = ?, description_ar = ?, main_image_url = ?
          WHERE id = ?
        `).bind(category, name_ar, name_ku || null, name_en || null, description_ar || null, main_image_url || null, productId).run();
      } else {
        const insertRes = await db.prepare(`
          INSERT INTO products (category, name_ar, name_ku, name_en, description_ar, main_image_url)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(category, name_ar, name_ku || null, name_en || null, description_ar || null, main_image_url || null).run();
        productId = insertRes.meta.last_row_id;
      }

      if (Array.isArray(variants)) {
        for (const v of variants) {
          if (v.variant_id) {
            await db.prepare(`
              UPDATE product_variants
              SET size_label = ?, price_iqd = ?, cost_iqd = ?, wholesale_price_iqd = ?, 
                  barcode = ?, stock_quantity = ?, in_stock = ?, image_url = ?
              WHERE id = ?
            `).bind(
              v.size_label,
              Number(v.price_iqd),
              Number(v.cost_iqd || 0),
              Number(v.wholesale_price_iqd || v.price_iqd),
              v.barcode || null,
              v.stock_quantity !== null && v.stock_quantity !== "" ? Number(v.stock_quantity) : null,
              v.in_stock ? 1 : 0,
              v.image_url || null,
              v.variant_id
            ).run();
          } else if (v.size_label) {
            await db.prepare(`
              INSERT INTO product_variants (
                product_id, size_label, price_iqd, cost_iqd, wholesale_price_iqd,
                barcode, stock_quantity, in_stock, image_url
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              productId,
              v.size_label,
              Number(v.price_iqd || 0),
              Number(v.cost_iqd || 0),
              Number(v.wholesale_price_iqd || v.price_iqd || 0),
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

    if (method === "GET" && path === "reports") {
      const url = new URL(request.url);
      const startDate = url.searchParams.get("start") || "1970-01-01";
      const endDate = url.searchParams.get("end") || "2099-12-31";

      const summaryQuery = `
        SELECT 
          COUNT(o.id) AS total_orders,
          COALESCE(SUM(o.total_iqd), 0) AS total_sales_iqd,
          COALESCE(SUM(o.discount_iqd), 0) AS total_discounts_iqd,
          COALESCE(SUM(oi.quantity * COALESCE(pv.cost_iqd, 0)), 0) AS total_cogs_iqd
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN product_variants pv ON oi.variant_id = pv.id
        WHERE DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) <= DATE(?) AND o.status = 'completed';
      `;
      const summary = await db.prepare(summaryQuery).bind(startDate, endDate).first();

      const channelQuery = `
        SELECT channel, COUNT(id) AS count, SUM(total_iqd) AS revenue
        FROM orders
        WHERE DATE(created_at) >= DATE(?) AND DATE(created_at) <= DATE(?) AND status = 'completed'
        GROUP BY channel;
      `;
      const byChannel = await db.prepare(channelQuery).bind(startDate, endDate).all();

      const staffQuery = `
        SELECT COALESCE(s.name, 'مبيعات الويب/أخرى') AS staff_name, COUNT(o.id) AS count, SUM(o.total_iqd) AS revenue
        FROM orders o
        LEFT JOIN staff s ON o.staff_id = s.id
        WHERE DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) <= DATE(?) AND o.status = 'completed'
        GROUP BY o.staff_id;
      `;
      const byStaff = await db.prepare(staffQuery).bind(startDate, endDate).all();

      const topProductsQuery = `
        SELECT oi.product_name_ar, oi.size_label, SUM(oi.quantity) AS total_qty, SUM(oi.line_total_iqd) AS total_revenue
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) <= DATE(?) AND o.status = 'completed'
        GROUP BY oi.product_name_ar, oi.size_label
        ORDER BY total_qty DESC
        LIMIT 10;
      `;
      const topProducts = await db.prepare(topProductsQuery).bind(startDate, endDate).all();

      const sales = Number(summary.total_sales_iqd || 0);
      const cogs = Number(summary.total_cogs_iqd || 0);
      const netProfit = sales - cogs;

      return jsonResponse({
        summary: {
          orders_count: summary.total_orders,
          gross_sales_iqd: sales,
          total_cogs_iqd: cogs,
          net_profit_iqd: netProfit,
          profit_margin_percent: sales > 0 ? ((netProfit / sales) * 100).toFixed(1) : 0
        },
        by_channel: byChannel.results || [],
        by_staff: byStaff.results || [],
        top_products: topProducts.results || []
      });
    }

    if (method === "GET" && path === "staff") {
      const { results } = await db.prepare(
        "SELECT id, name, role, permissions, is_active FROM staff ORDER BY id ASC"
      ).all();
      return jsonResponse({
        staff: results.map(s => ({
          ...s,
          permissions: JSON.parse(s.permissions || "[]")
        }))
      });
    }

    if (method === "POST" && path === "staff") {
      const body = await request.json();
      const { id, name, pin, role, permissions, is_active } = body;

      if (!name) {
        return jsonResponse({ error: "Staff name is required" }, 400);
      }

      const permsJson = JSON.stringify(permissions || []);

      if (id) {
        if (pin && String(pin).trim() !== "") {
          const pinH = await hashPin(pin);
          await db.prepare(
            "UPDATE staff SET name = ?, pin_hash = ?, role = ?, permissions = ?, is_active = ? WHERE id = ?"
          ).bind(name, pinH, role || "cashier", permsJson, is_active ? 1 : 0, id).run();
        } else {
          await db.prepare(
            "UPDATE staff SET name = ?, role = ?, permissions = ?, is_active = ? WHERE id = ?"
          ).bind(name, role || "cashier", permsJson, is_active ? 1 : 0, id).run();
        }
      } else {
        if (!pin) {
          return jsonResponse({ error: "PIN is required for new staff" }, 400);
        }
        const pinH = await hashPin(pin);
        await db.prepare(
          "INSERT INTO staff (name, pin_hash, role, permissions, is_active) VALUES (?, ?, ?, ?, ?)"
        ).bind(name, pinH, role || "cashier", permsJson, 1).run();
      }

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: `Route '/api/${path}' not found` }, 404);
  } catch (err) {
    return jsonResponse({ error: "Internal Server Error", message: err.message }, 500);
  }
}
