-- Production application schema. Never run loadtest/db scripts against this database.
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  UNIQUE (id, tenant_id)
);
CREATE TABLE booths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  session_mode text NOT NULL DEFAULT 'disabled' CHECK (session_mode IN ('disabled','event','voucher','paid')),
  price_idr integer NOT NULL DEFAULT 0 CHECK (price_idr >= 0),
  event_tokens_remaining integer NOT NULL DEFAULT 0 CHECK (event_tokens_remaining >= 0),
  config_version bigint NOT NULL DEFAULT 0,
  applied_config_version bigint NOT NULL DEFAULT 0,
  device_token_sha256 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE TABLE frame_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE booth_config_versions (
  booth_id uuid NOT NULL REFERENCES booths(id),
  version bigint NOT NULL CHECK (version > 0),
  frame_version_ids uuid[] NOT NULL CHECK (cardinality(frame_version_ids) > 0),
  price_idr integer NOT NULL CHECK (price_idr >= 0),
  first_photo_timer_seconds integer NOT NULL CHECK (first_photo_timer_seconds BETWEEN 0 AND 60),
  remaining_photo_timer_seconds integer NOT NULL CHECK (remaining_photo_timer_seconds BETWEEN 0 AND 60),
  retake_limit integer NOT NULL CHECK (retake_limit BETWEEN 0 AND 8),
  camera_settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(camera_settings) = 'object'),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booth_id, version)
);
CREATE FUNCTION publish_booth_configuration(
  p_booth_id uuid, p_frames uuid[], p_price_idr integer,
  p_first_timer integer, p_remaining_timer integer, p_retake_limit integer,
  p_camera_settings jsonb
) RETURNS SETOF booth_config_versions LANGUAGE plpgsql AS $$
DECLARE
  v_booth booths%ROWTYPE;
  v_config booth_config_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_booth FROM booths WHERE id = p_booth_id FOR UPDATE;
  IF NOT FOUND OR NOT v_booth.active OR cardinality(p_frames) < 1 OR
     (SELECT count(DISTINCT id) FROM frame_versions WHERE id = ANY(p_frames) AND tenant_id = v_booth.tenant_id) <> cardinality(p_frames) THEN RETURN; END IF;
  INSERT INTO booth_config_versions (
    booth_id, version, frame_version_ids, price_idr, first_photo_timer_seconds,
    remaining_photo_timer_seconds, retake_limit, camera_settings
  ) VALUES (
    p_booth_id, v_booth.config_version + 1, p_frames, p_price_idr,
    p_first_timer, p_remaining_timer, p_retake_limit, p_camera_settings
  ) RETURNING * INTO v_config;
  UPDATE booths SET config_version = v_config.version, price_idr = p_price_idr WHERE id = p_booth_id;
  RETURN NEXT v_config;
END $$;
CREATE FUNCTION reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published versions are immutable';
END $$;
CREATE TRIGGER frame_versions_immutable BEFORE UPDATE ON frame_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER booth_configs_immutable BEFORE UPDATE ON booth_config_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TABLE config_apply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booth_id uuid NOT NULL REFERENCES booths(id),
  event_id uuid NOT NULL,
  version bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('applied','rejected')),
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booth_id, event_id)
);
CREATE FUNCTION record_config_apply(p_booth_id uuid, p_event_id uuid, p_version bigint, p_status text, p_reason text)
RETURNS SETOF config_apply_events LANGUAGE plpgsql AS $$
DECLARE
  v_booth booths%ROWTYPE;
  v_existing config_apply_events%ROWTYPE;
  v_event config_apply_events%ROWTYPE;
BEGIN
  SELECT * INTO v_booth FROM booths WHERE id = p_booth_id FOR UPDATE;
  IF NOT FOUND OR NOT v_booth.active OR p_version > v_booth.config_version OR p_version < 1 THEN RETURN; END IF;
  SELECT * INTO v_existing FROM config_apply_events WHERE booth_id = p_booth_id AND event_id = p_event_id;
  IF FOUND THEN RETURN NEXT v_existing; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM booth_config_versions WHERE booth_id = p_booth_id AND version = p_version) THEN RETURN; END IF;
  INSERT INTO config_apply_events (booth_id,event_id,version,status,reason)
    VALUES (p_booth_id,p_event_id,p_version,p_status,p_reason) RETURNING * INTO v_event;
  IF p_status = 'applied' THEN
    UPDATE booths SET applied_config_version = GREATEST(applied_config_version, p_version) WHERE id = p_booth_id;
  END IF;
  RETURN NEXT v_event;
END $$;
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  booth_id uuid NOT NULL,
  client_session_id uuid NOT NULL,
  frame_version_id uuid REFERENCES frame_versions(id),
  config_version bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('event','voucher','paid')),
  price_idr integer NOT NULL CHECK (price_idr >= 0),
  status text NOT NULL CHECK (status IN ('authorized','captured','ready','cancelled')),
  capture_event_id uuid,
  photo_count integer CHECK (photo_count BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz,
  ready_at timestamptz,
  UNIQUE (booth_id, client_session_id),
  FOREIGN KEY (booth_id, tenant_id) REFERENCES booths(id, tenant_id)
);
CREATE INDEX sessions_booth_created_idx ON sessions (booth_id, created_at DESC);
CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  booth_id uuid REFERENCES booths(id),
  code_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  redeemed_session_id uuid UNIQUE REFERENCES sessions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN voucher_id uuid REFERENCES vouchers(id);
-- Serialize per-booth token consumption. A retry with the same client ID reuses
-- the first session and cannot spend another event token.
CREATE FUNCTION create_event_session(p_booth_id uuid, p_client_session_id uuid)
RETURNS SETOF sessions LANGUAGE plpgsql AS $$
DECLARE
  v_booth booths%ROWTYPE;
  v_existing sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_booth FROM booths WHERE id = p_booth_id FOR UPDATE;
  IF NOT FOUND OR NOT v_booth.active OR v_booth.session_mode <> 'event' THEN
    RETURN;
  END IF;
  SELECT * INTO v_existing FROM sessions WHERE booth_id = p_booth_id AND client_session_id = p_client_session_id;
  IF FOUND THEN
    RETURN NEXT v_existing;
    RETURN;
  END IF;
  IF v_booth.event_tokens_remaining < 1 THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM booth_config_versions WHERE booth_id = p_booth_id AND version = v_booth.config_version) THEN RETURN; END IF;
  UPDATE booths SET event_tokens_remaining = event_tokens_remaining - 1 WHERE id = p_booth_id;
  RETURN QUERY INSERT INTO sessions (tenant_id, booth_id, client_session_id, config_version, mode, price_idr, status)
    VALUES (v_booth.tenant_id, p_booth_id, p_client_session_id, v_booth.config_version, 'event', 0, 'authorized') RETURNING *;
END $$;
-- Lock the booth first, then the voucher. A single-use code is consumed when
-- authorization is issued; cancellation and failed prints require support review.
CREATE FUNCTION create_voucher_session(p_booth_id uuid, p_client_session_id uuid, p_code_digest text)
RETURNS SETOF sessions LANGUAGE plpgsql AS $$
DECLARE
  v_booth booths%ROWTYPE;
  v_voucher vouchers%ROWTYPE;
  v_existing sessions%ROWTYPE;
  v_session sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_booth FROM booths WHERE id = p_booth_id FOR UPDATE;
  IF NOT FOUND OR NOT v_booth.active OR v_booth.session_mode = 'disabled' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM booth_config_versions WHERE booth_id = p_booth_id AND version = v_booth.config_version) THEN RETURN; END IF;
  SELECT * INTO v_existing FROM sessions WHERE booth_id = p_booth_id AND client_session_id = p_client_session_id;
  IF FOUND THEN
    IF v_existing.mode <> 'voucher' THEN RETURN; END IF;
    SELECT * INTO v_voucher FROM vouchers WHERE id = v_existing.voucher_id;
    IF v_voucher.code_digest = p_code_digest THEN RETURN NEXT v_existing; END IF;
    RETURN;
  END IF;
  SELECT * INTO v_voucher FROM vouchers WHERE code_digest = p_code_digest FOR UPDATE;
  IF NOT FOUND OR v_voucher.tenant_id <> v_booth.tenant_id OR
     (v_voucher.booth_id IS NOT NULL AND v_voucher.booth_id <> p_booth_id) OR
     v_voucher.expires_at <= now() OR v_voucher.redeemed_session_id IS NOT NULL THEN RETURN; END IF;
  INSERT INTO sessions (tenant_id, booth_id, client_session_id, config_version, mode, price_idr, status, voucher_id)
    VALUES (v_booth.tenant_id, p_booth_id, p_client_session_id, v_booth.config_version, 'voucher', 0, 'authorized', v_voucher.id)
    RETURNING * INTO v_session;
  UPDATE vouchers SET redeemed_session_id = v_session.id WHERE id = v_voucher.id;
  RETURN NEXT v_session;
END $$;
CREATE TABLE media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  kind text NOT NULL CHECK (kind IN ('composite','gif')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/gif')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20000000),
  sha256 text NOT NULL,
  object_key text NOT NULL UNIQUE,
  upload_token_sha256 text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  retention_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  deleted_at timestamptz,
  UNIQUE (session_id, kind)
);
CREATE INDEX media_expiry_idx ON media_uploads (retention_at, id) WHERE deleted_at IS NULL;
CREATE TABLE print_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  event_id uuid NOT NULL,
  client_job_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','confirmed','failed','uncertain')),
  spooler_job_id text,
  occurred_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_id)
);
CREATE INDEX print_events_job_idx ON print_events (session_id, client_job_id, occurred_at);
CREATE TABLE shares (
  session_id uuid PRIMARY KEY REFERENCES sessions(id),
  token_sha256 text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
-- Finalization sets the 30-day clock for both files and the share link.
-- Unfinished uploads keep their own 30-day cleanup deadline.
CREATE FUNCTION finalize_session(p_session_id uuid)
RETURNS SETOF sessions LANGUAGE plpgsql AS $$
DECLARE
  v_session sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_session.status = 'ready' THEN RETURN NEXT v_session; RETURN; END IF;
  IF v_session.status <> 'captured' OR
     (SELECT count(*) FROM media_uploads WHERE session_id = p_session_id AND kind IN ('composite','gif') AND uploaded_at IS NOT NULL) <> 2 OR
     NOT EXISTS (SELECT 1 FROM print_events WHERE session_id = p_session_id AND status = 'confirmed') THEN RETURN; END IF;
  UPDATE sessions SET status = 'ready', ready_at = now() WHERE id = p_session_id RETURNING * INTO v_session;
  UPDATE media_uploads SET retention_at = v_session.ready_at + interval '30 days' WHERE session_id = p_session_id;
  RETURN NEXT v_session;
END $$;
-- Later paid-mode migrations add immutable gateway events and authorization.
-- No booth request may itself mark a paid session authorized.
