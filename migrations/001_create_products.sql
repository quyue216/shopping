-- 001_create_products.sql
-- 商品表
-- 价格约定：以整数“分”存储（¥12.34 -> 1234），禁止浮点

CREATE TABLE products (
    id          BIGSERIAL    PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    price       BIGINT       NOT NULL,
    stock       INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_products_name_not_blank CHECK (length(btrim(name)) > 0),
    CONSTRAINT chk_products_price_non_negative CHECK (price >= 0),
    CONSTRAINT chk_products_stock_non_negative CHECK (stock >= 0)
);

COMMENT ON TABLE  products            IS '商品表';
COMMENT ON COLUMN products.id         IS '商品 ID，自增主键';
COMMENT ON COLUMN products.name       IS '商品名称';
COMMENT ON COLUMN products.price      IS '价格，单位：分';
COMMENT ON COLUMN products.stock      IS '可用库存';
COMMENT ON COLUMN products.created_at IS '创建时间';
