CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    name_ku TEXT,
    name_en TEXT,
    description_ar TEXT,
    main_image_url TEXT,
    is_bundle INTEGER DEFAULT 0,
    bundle_items_json TEXT,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    size_label TEXT NOT NULL,
    price_iqd INTEGER NOT NULL,
    cost_iqd INTEGER DEFAULT 0,
    wholesale_price_iqd INTEGER DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    barcode TEXT,
    stock_quantity INTEGER DEFAULT 0,
    in_stock INTEGER DEFAULT 1,
    image_url TEXT,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('manager', 'assistant_manager', 'cashier')) NOT NULL,
    permissions TEXT,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
    phone TEXT PRIMARY KEY,
    name TEXT,
    default_address TEXT,
    notes TEXT,
    total_spent_iqd INTEGER DEFAULT 0,
    orders_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL,
    address TEXT NOT NULL,
    landmark TEXT,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    channel TEXT CHECK(channel IN ('web', 'pos')) NOT NULL,
    status TEXT CHECK(status IN ('pending', 'completed', 'cancelled')) DEFAULT 'completed',
    staff_id INTEGER,
    subtotal_iqd INTEGER NOT NULL,
    delivery_fee_iqd INTEGER DEFAULT 0,
    discount_iqd INTEGER DEFAULT 0,
    total_iqd INTEGER NOT NULL,
    payment_method TEXT DEFAULT 'cash',
    cash_tendered_iqd INTEGER DEFAULT 0,
    change_due_iqd INTEGER DEFAULT 0,
    customer_name TEXT,
    customer_phone TEXT,
    zone_id TEXT,
    address TEXT,
    landmark TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    variant_id INTEGER,
    product_name_ar TEXT NOT NULL,
    size_label TEXT NOT NULL,
    unit_price_iqd INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    line_total_iqd INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode);
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_phone ON customer_addresses(customer_phone);
