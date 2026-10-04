-- Application-owned identity; existing imported admins must set a password
-- through the controlled reset command before they can sign in.
ALTER TABLE admin_users DROP COLUMN access_sub;
ALTER TABLE admin_users ADD COLUMN password_hash text;
CREATE UNIQUE INDEX admin_email_unique ON admin_users(lower(email));

CREATE TABLE admin_sessions (
  token_sha256 text PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_user ON admin_sessions(admin_id);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE auth_attempts (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  window_end timestamptz NOT NULL
);

CREATE FUNCTION change_admin_password(p_admin uuid, p_old_hash text, p_new_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE admin_users SET password_hash=p_new_hash
    WHERE id=p_admin AND active=true AND password_hash=p_old_hash;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM admin_sessions WHERE admin_id=p_admin;
  RETURN true;
END $$;
