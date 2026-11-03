-- 002_create_orders.sql
-- 金额与 products.price 一致，使用 BIGINT 存储整数“分”。
-- 迁移脚本已为整个文件开启事务，这里不重复 BEGIN / COMMIT。

CREATE TABLE orders (
    id               BIGSERIAL    PRIMARY KEY,
    user_id          BIGINT       NOT NULL,
    total_amount     BIGINT       NOT NULL,
    idempotency_key  VARCHAR(128) NOT NULL,
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- TODO: 创建用户表后，为 user_id 添加外键约束。
    CONSTRAINT chk_orders_total_amount_non_negative CHECK (total_amount >= 0),
    CONSTRAINT chk_orders_idempotency_key_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT chk_orders_status CHECK (status IN ('pending', 'paid', 'cancelled')),
    CONSTRAINT uq_orders_user_idempotency_key UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_orders_user_created_at ON orders (user_id, created_at DESC);

COMMENT ON TABLE orders IS '订单表';
COMMENT ON COLUMN orders.id IS '订单 ID，自增主键';
COMMENT ON COLUMN orders.user_id IS '用户 ID，用户表创建后补充外键';
COMMENT ON COLUMN orders.total_amount IS '订单应付总金额，单位：分；由业务在事务中核算';
COMMENT ON COLUMN orders.idempotency_key IS '下单幂等键，同一用户下唯一';
COMMENT ON COLUMN orders.status IS '订单状态：pending 待支付、paid 已支付、cancelled 已取消';
COMMENT ON COLUMN orders.created_at IS '创建时间';
COMMENT ON COLUMN orders.updated_at IS '更新时间，更新时由触发器维护';

CREATE TABLE order_items (
    id            BIGSERIAL    PRIMARY KEY,
    order_id      BIGINT       NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    product_id    BIGINT       NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name  VARCHAR(255) NOT NULL,
    unit_price    BIGINT       NOT NULL,
    quantity      INTEGER      NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_order_items_product_name_not_blank
        CHECK (length(btrim(product_name)) > 0),
    CONSTRAINT chk_order_items_unit_price_non_negative CHECK (unit_price >= 0),
    CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);

COMMENT ON TABLE order_items IS '订单明细表，保存下单时的商品快照';
COMMENT ON COLUMN order_items.id IS '订单明细 ID，自增主键';
COMMENT ON COLUMN order_items.order_id IS '所属订单 ID';
COMMENT ON COLUMN order_items.product_id IS '商品 ID，有订单明细引用时禁止物理删除商品';
COMMENT ON COLUMN order_items.product_name IS '下单时的商品名称快照';
COMMENT ON COLUMN order_items.unit_price IS '下单时的成交单价快照，单位：分';
COMMENT ON COLUMN order_items.quantity IS '购买数量，必须大于 0';
COMMENT ON COLUMN order_items.created_at IS '创建时间';
COMMENT ON COLUMN order_items.updated_at IS '更新时间，更新时由触发器维护';

CREATE FUNCTION set_order_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_order_updated_at();

CREATE TRIGGER trg_order_items_updated_at
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION set_order_updated_at();
