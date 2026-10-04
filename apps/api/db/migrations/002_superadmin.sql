-- Apply after 001_session_core.sql. Bootstrap the first superadmin only through
-- a controlled database operation. Migration 003 replaces legacy identity.
CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_sub text NOT NULL UNIQUE,
  email text NOT NULL,
  role text NOT NULL CHECK (role = 'superadmin'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id uuid NOT NULL REFERENCES admin_users(id),
  action text NOT NULL,
  target_id uuid NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE booths ADD COLUMN enrollment_request_id uuid UNIQUE;
ALTER TABLE vouchers ADD COLUMN issue_request_id uuid UNIQUE;
ALTER TABLE vouchers ADD COLUMN created_by_admin_id uuid REFERENCES admin_users(id);
ALTER TABLE frame_versions ADD COLUMN publish_request_id uuid UNIQUE;
ALTER TABLE booth_config_versions ADD COLUMN publish_request_id uuid UNIQUE;

CREATE FUNCTION admin_enroll_booth(p_actor uuid, p_request uuid, p_tenant uuid, p_site uuid, p_name text, p_digest text)
RETURNS SETOF booths LANGUAGE plpgsql AS $$
DECLARE v_booth booths%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO v_booth FROM booths WHERE enrollment_request_id=p_request;
  IF FOUND THEN RETURN NEXT v_booth; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id=p_site AND tenant_id=p_tenant) THEN RETURN; END IF;
  INSERT INTO booths (tenant_id,site_id,name,session_mode,device_token_sha256,enrollment_request_id)
    VALUES (p_tenant,p_site,p_name,'voucher',p_digest,p_request) RETURNING * INTO v_booth;
  INSERT INTO audit_events(actor_admin_id,action,target_id,request_id)
    VALUES(p_actor,'booth.enroll',v_booth.id,p_request);
  RETURN NEXT v_booth;
END $$;

CREATE FUNCTION admin_issue_voucher(p_actor uuid, p_request uuid, p_tenant uuid, p_booth uuid, p_digest text, p_expires timestamptz)
RETURNS SETOF vouchers LANGUAGE plpgsql AS $$
DECLARE v_voucher vouchers%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO v_voucher FROM vouchers WHERE issue_request_id=p_request;
  IF FOUND THEN RETURN NEXT v_voucher; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM tenants WHERE id=p_tenant) OR p_expires <= now() OR p_expires > now()+interval '1 year' OR
     (p_booth IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booths WHERE id=p_booth AND tenant_id=p_tenant)) THEN RETURN; END IF;
  INSERT INTO vouchers(tenant_id,booth_id,code_digest,expires_at,issue_request_id,created_by_admin_id)
    VALUES(p_tenant,p_booth,p_digest,p_expires,p_request,p_actor) RETURNING * INTO v_voucher;
  INSERT INTO audit_events(actor_admin_id,action,target_id,request_id)
    VALUES(p_actor,'voucher.issue',v_voucher.id,p_request);
  RETURN NEXT v_voucher;
END $$;

CREATE FUNCTION admin_publish_frame(p_actor uuid,p_request uuid,p_tenant uuid,p_name text,p_manifest jsonb,p_hash text)
RETURNS SETOF frame_versions LANGUAGE plpgsql AS $$
DECLARE v_frame frame_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO v_frame FROM frame_versions WHERE publish_request_id=p_request;
  IF FOUND THEN RETURN NEXT v_frame; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM tenants WHERE id=p_tenant) THEN RETURN; END IF;
  INSERT INTO frame_versions(tenant_id,name,manifest,manifest_sha256,publish_request_id)
    VALUES(p_tenant,p_name,p_manifest,p_hash,p_request) RETURNING * INTO v_frame;
  INSERT INTO audit_events(actor_admin_id,action,target_id,request_id)
    VALUES(p_actor,'frame.publish',v_frame.id,p_request);
  RETURN NEXT v_frame;
END $$;

CREATE FUNCTION admin_publish_configuration(
  p_actor uuid,p_request uuid,p_booth uuid,p_frames uuid[],p_price integer,
  p_first integer,p_remaining integer,p_retakes integer,p_camera jsonb
) RETURNS SETOF booth_config_versions LANGUAGE plpgsql AS $$
DECLARE v_booth booths%ROWTYPE; v_config booth_config_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  SELECT * INTO v_booth FROM booths WHERE id=p_booth FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_config FROM booth_config_versions WHERE publish_request_id=p_request;
  IF FOUND THEN RETURN NEXT v_config; RETURN; END IF;
  IF NOT v_booth.active OR cardinality(p_frames)<1 OR
     (SELECT count(DISTINCT id) FROM frame_versions WHERE id=ANY(p_frames) AND tenant_id=v_booth.tenant_id)<>cardinality(p_frames) THEN RETURN; END IF;
  INSERT INTO booth_config_versions(booth_id,version,frame_version_ids,price_idr,
    first_photo_timer_seconds,remaining_photo_timer_seconds,retake_limit,camera_settings,publish_request_id)
    VALUES(p_booth,v_booth.config_version+1,p_frames,p_price,p_first,p_remaining,p_retakes,p_camera,p_request)
    RETURNING * INTO v_config;
  UPDATE booths SET config_version=v_config.version,price_idr=p_price WHERE id=p_booth;
  INSERT INTO audit_events(actor_admin_id,action,target_id,request_id)
    VALUES(p_actor,'configuration.publish',p_booth,p_request);
  RETURN NEXT v_config;
END $$;
