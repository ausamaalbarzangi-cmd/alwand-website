-- Disable foreign key constraints during table creation
PRAGMA foreign_keys = ON;

-- 1. PRODUCTS (Parent Catalog)
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,                     -- e.g., 'زيوت طبيعية', 'خلطات علاجية', 'مستحضرات عناية'
    name_ar TEXT NOT NULL,
    name_ku TEXT,
    name_en TEXT,
    description_ar TEXT,
    description_ku TEXT,
    description_en TEXT,
    main_image_url TEXT,                        -- Primary fallback image
    is_active INTEGER NOT NULL DEFAULT 1,       -- 1 = visible on site/POS, 0 = hidden
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. PRODUCT VARIANTS (Sizes, Prices, and Variant-Specific Images)
CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    size_label TEXT NOT NULL,                   -- e.g., '100ml', '50ml', '20ml', 'قياس موحد'
    price_iqd INTEGER NOT NULL,                 -- Stored as integer IQD (e.g., 10000, 6000)
    cost_iqd INTEGER DEFAULT 0,                 -- Internal unit cost for profit analysis
    image_url TEXT,                             -- Specific size image; falls back to products.main_image_url if NULL
    in_stock INTEGER NOT NULL DEFAULT 1,        -- 1 = in stock, 0 = out of stock
    stock_quantity INTEGER DEFAULT NULL,        -- Optional inventory counter (NULL if untracked)
    sort_order INTEGER DEFAULT 1,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- 3. DELIVERY ZONES & FEES
CREATE TABLE IF NOT EXISTS delivery_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_ar TEXT NOT NULL,                      -- e.g., 'خانقين - المركز'
    name_ku TEXT,
    name_en TEXT,
    fee_iqd INTEGER NOT NULL DEFAULT 0,         -- e.g., 3000, 5000
    is_active INTEGER NOT NULL DEFAULT 1
);

-- 4. STAFF USERS (POS Access)
CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,                     -- SHA-256 hashed 4-digit PIN
    role TEXT NOT NULL DEFAULT 'cashier',       -- 'cashier', 'manager'
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. ORDERS (Both POS and Online Deliveries)
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,          -- e.g., 'POS-2611-0001', 'WEB-2611-0001'
    channel TEXT NOT NULL CHECK(channel IN ('web', 'pos')),
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'processing', 'completed', 'cancelled')),
    staff_id INTEGER,                           -- NULL for web self-checkout
    subtotal_iqd INTEGER NOT NULL,
    delivery_fee_iqd INTEGER NOT NULL DEFAULT 0,
    discount_iqd INTEGER NOT NULL DEFAULT 0,
    total_iqd INTEGER NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash', 'zaincash', 'card', 'cod')),
    cash_tendered_iqd INTEGER,                  -- Exact amount handed by customer (for change calculation)
    change_due_iqd INTEGER,                      -- Change returned to customer
    customer_name TEXT,
    customer_phone TEXT,
    zone_id INTEGER,
    address TEXT,
    landmark TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(id),
    FOREIGN KEY (zone_id) REFERENCES delivery_zones(id)
);

-- 6. ORDER ITEMS (Immutable Snapshots of Purchased Items)
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    variant_id INTEGER,
    product_name_ar TEXT NOT NULL,              -- Historical snapshot in case product name changes later
    size_label TEXT NOT NULL,
    unit_price_iqd INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    line_total_iqd INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
);

-- 7. BUNDLES & SPECIAL PROMOTIONS
CREATE TABLE IF NOT EXISTS bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_ar TEXT NOT NULL,
    name_ku TEXT,
    name_en TEXT,
    description_ar TEXT,
    bundle_price_iqd INTEGER NOT NULL,
    original_price_iqd INTEGER,
    image_url TEXT,
    in_stock INTEGER NOT NULL DEFAULT 1,
    start_date DATETIME,
    end_date DATETIME,
    is_active INTEGER NOT NULL DEFAULT 1
);

-- PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
