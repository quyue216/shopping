-- 008_create_users.sql
-- 用户表。同时兑现 002 的 TODO：为 orders.user_id 补充外键。

CREATE TABLE users (
    id            BIGSERIAL    PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT chk_users_username_not_blank CHECK (length(btrim(username)) > 0),
    -- 粗校验：包含 @ 且 @ 前后都有字符；严格校验由应用层负责
    CONSTRAINT chk_users_email_format
        CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT chk_users_password_hash_not_blank CHECK (length(btrim(password_hash)) > 0)
);

COMMENT ON TABLE  users                IS '用户表';
COMMENT ON COLUMN users.id             IS '用户 ID，自增主键';
COMMENT ON COLUMN users.username       IS '登录用户名，唯一';
COMMENT ON COLUMN users.email          IS '邮箱，唯一，用于登录/找回密码';
COMMENT ON COLUMN users.password_hash  IS '密码哈希（bcrypt/argon2），绝不存明文';
COMMENT ON COLUMN users.created_at     IS '创建时间';
COMMENT ON COLUMN users.updated_at     IS '更新时间，更新时由触发器维护';

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_order_updated_at();

-- 兑现 002 的 TODO：orders.user_id 关联用户表。
-- RESTRICT：有订单的用户禁止物理删除（订单必须留存）。
ALTER TABLE orders
    ADD CONSTRAINT fk_orders_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN orders.user_id IS '下单用户 ID';
