// Global placeholder if neither size image nor main product image exists
const DEFAULT_PLACEHOLDER = "https://img.alwandoilpress.com/placeholder.png";

// Simple SHA-256 helper for staff PIN comparison
async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(pin).trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Standard JSON response helper with CORS
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: "D1 database binding 'DB' not found in Cloudflare Pages settings." }, 500);
  }

  // Parse path: /api/products, /api/orders, /api/zones, /api/auth
  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const method = request.method;

  try {
    // ----------------------------------------------------
    // 1. GET /api/products (Used by both Website and POS)
    // ----------------------------------------------------
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
          v.in_stock,
          v.stock_quantity,
          COALESCE(v.image_url, p.main_image_url, ?) AS display_image
        FROM products p
        LEFT JOIN product_variants v ON p.id = v.product_id
        WHERE p.is_active = 1
        ORDER BY p.id ASC, v.sort_order ASC;
      `;

      const { results } = await db.prepare(query).bind(DEFAULT_PLACEHOLDER).all();

      // Group variants under their parent product
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
            in_stock: Boolean(row.in_stock),
            stock_quantity: row.stock_quantity,
            image_url: row.display_image
          });
        }
      }

      return jsonResponse({ products: Array.from(catalogMap.values()) });
    }

    // ----------------------------------------------------
    // 2. GET /api/zones (Delivery Zones & Fees)
    // ----------------------------------------------------
    if (method === "GET" && path === "zones") {
      const { results } = await db.prepare(
        "SELECT id, name_ar, name_ku, name_en, fee_iqd FROM delivery_zones WHERE is_active = 1 ORDER BY fee_iqd ASC"
      ).all();
      return jsonResponse({ zones: results });
    }

    // ----------------------------------------------------
    // 3. POST /api/auth (Staff POS Login)
    // ----------------------------------------------------
    if (method === "POST" && path === "auth") {
      const body = await request.json();
      const pin = body.pin;

      if (!pin) {
        return jsonResponse({ error: "PIN is required" }, 400);
      }

      const inputHash = await hashPin(pin);
      const staffMember = await db.prepare(
        "SELECT id, name, role FROM staff WHERE pin_hash = ? AND is_active = 1"
      ).bind(inputHash).first();

      if (!staffMember) {
        return jsonResponse({ error: "Invalid PIN" }, 401);
      }

      return jsonResponse({
        success: true,
        staff: {
          id: staffMember.id,
          name: staffMember.name,
          role: staffMember.role
        }
      });
    }

    // ----------------------------------------------------
    // 4. POST /api/orders (Submits Web or POS Orders)
    // ----------------------------------------------------
    if (method === "POST" && (path === "orders" || path === "submitOrder")) {
      const body = await request.json();
      const channel = body.channel || (body.orderId ? "web" : "pos");
      const items = body.items || [];

      if (!items.length) {
        return jsonResponse({ error: "Cannot process an empty order" }, 400);
      }

      // Generate Order Number: POS-2611-XXXX or WEB-2611-XXXX
      const datePrefix = new Date().toISOString().slice(2, 7).replace("-", "");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderNumber = `${channel.toUpperCase()}-${datePrefix}-${randomSuffix}`;

      // Calculate totals and validate items
      let subtotal = 0;
      for (const item of items) {
        subtotal += Number(item.unit_price_iqd) * Number(item.quantity);
      }

      const deliveryFee = Number(body.delivery_fee_iqd) || 0;
      const discount = Number(body.discount_iqd) || 0;
      const total = subtotal + deliveryFee - discount;

      const cashTendered = body.cash_tendered_iqd ? Number(body.cash_tendered_iqd) : null;
      const changeDue = cashTendered !== null ? Math.max(0, cashTendered - total) : null;

      // Atomic Batch Execution: Create Order + Insert Line Items + Deduct Inventory
      const statements = [];

      // A. Insert Master Order Record
      statements.push(
        db.prepare(`
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
        )
      );

      // Execute order creation first to obtain the internal ID
      const orderResult = await statements[0].run();
      const newOrderId = orderResult.meta.last_row_id;

      // B. Line items and inventory deductions
      const batchItems = [];
      for (const item of items) {
        batchItems.push(
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

        // Deduct numeric stock if tracked
        if (item.variant_id) {
          batchItems.push(
            db.prepare(`
              UPDATE product_variants 
              SET stock_quantity = MAX(0, stock_quantity - ?) 
              WHERE id = ? AND stock_quantity IS NOT NULL
            `).bind(item.quantity, item.variant_id)
          );
        }
      }

      await db.batch(batchItems);

      return jsonResponse({
        success: true,
        order_number: orderNumber,
        total_iqd: total,
        change_due_iqd: changeDue
      });
    }

    return jsonResponse({ error: `Route '/api/${path}' not found` }, 404);
  } catch (err) {
    return jsonResponse({ error: "Internal Server Error", message: err.message }, 500);
  }
}
