CREATE EXTENSION IF NOT EXISTS btree_gist;
-- statement
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, name text NOT NULL, phone text UNIQUE NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','barista')), active boolean NOT NULL DEFAULT true,
 rate numeric(12,2) CHECK(rate >= 0), pay_type text NOT NULL DEFAULT 'hourly' CHECK(pay_type IN ('hourly','shift')),
 must_change_password boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf text NOT NULL, expires_at timestamptz NOT NULL);
-- statement
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
-- statement
CREATE TABLE IF NOT EXISTS shift_types (
 id uuid PRIMARY KEY, name text NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
 pay_type text NOT NULL CHECK(pay_type IN ('hourly','shift')), rate numeric(12,2) NOT NULL CHECK(rate >= 0),
 allow_exchange boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 CHECK(start_time < end_time)
);
-- statement
CREATE TABLE IF NOT EXISTS shifts (
 id uuid PRIMARY KEY, date date NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
 type_id uuid NOT NULL REFERENCES shift_types(id), user_id uuid REFERENCES users(id),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','confirmed','worked','closed','cancelled')),
 pay_type text NOT NULL CHECK(pay_type IN ('hourly','shift')), rate numeric(12,2) NOT NULL CHECK(rate >= 0), rate_override boolean NOT NULL DEFAULT false,
 exchanged boolean NOT NULL DEFAULT false, exchange_locked boolean NOT NULL DEFAULT false,
 comment text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(start_at < end_at), CHECK((start_at AT TIME ZONE 'Europe/Minsk')::date = date AND (end_at AT TIME ZONE 'Europe/Minsk')::date = date),
 EXCLUDE USING gist (user_id WITH =, tstzrange(start_at,end_at,'[)') WITH &&) WHERE (user_id IS NOT NULL AND status <> 'cancelled')
);
-- statement
CREATE TABLE IF NOT EXISTS exchange_listings (
 id uuid PRIMARY KEY, shift_id uuid NOT NULL REFERENCES shifts(id), listed_by uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','taken','cancelled','expired','rolled_back')),
 taken_by uuid REFERENCES users(id), old_pay_type text, old_rate numeric(12,2),
 closes_at timestamptz NOT NULL, taken_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement
CREATE UNIQUE INDEX IF NOT EXISTS one_open_listing ON exchange_listings(shift_id) WHERE status = 'open';
-- statement
CREATE TABLE IF NOT EXISTS adjustments (
 id uuid PRIMARY KEY, shift_id uuid NOT NULL REFERENCES shifts(id), user_id uuid NOT NULL REFERENCES users(id),
 minutes integer NOT NULL DEFAULT 0, amount numeric(12,2) NOT NULL DEFAULT 0, reason text NOT NULL CHECK(length(trim(reason)) > 0),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, body text NOT NULL,
 category text NOT NULL, link text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dedup_key text UNIQUE
);
-- statement
CREATE TABLE IF NOT EXISTS preferences (user_id uuid PRIMARY KEY REFERENCES users(id), schedule boolean NOT NULL DEFAULT true, exchange boolean NOT NULL DEFAULT true, adjustments boolean NOT NULL DEFAULT true, admin boolean NOT NULL DEFAULT true, reminder_120 boolean NOT NULL DEFAULT true, reminder_60 boolean NOT NULL DEFAULT false);
-- statement
CREATE TABLE IF NOT EXISTS push_devices (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- statement
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web' CHECK(platform IN ('web','android'));
-- statement
CREATE TABLE IF NOT EXISTS deliveries (id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES notifications(id), device_id uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE, attempts integer NOT NULL DEFAULT 0, sent_at timestamptz, next_attempt timestamptz NOT NULL DEFAULT clock_timestamp(), last_error text, UNIQUE(notification_id,device_id));
-- statement
CREATE TABLE IF NOT EXISTS audit_logs (id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, entity text NOT NULL, entity_id uuid, before_value jsonb, after_value jsonb, reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- statement
CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- statement
CREATE TABLE IF NOT EXISTS idempotency (user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,key));
-- statement
CREATE INDEX IF NOT EXISTS shifts_calendar ON shifts(date);
-- statement
CREATE INDEX IF NOT EXISTS shifts_user_date ON shifts(user_id,date);
-- statement
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at DESC);
-- statement
CREATE INDEX IF NOT EXISTS exchange_expiry ON exchange_listings(status,closes_at);
