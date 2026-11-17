CREATE INDEX idx_mails_recipient_folder_timestamp ON mails (LOWER(TRIM(to_address)), folder, timestamp DESC);

CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_record TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE member_domains (
  member_id TEXT NOT NULL REFERENCES members(id),
  domain TEXT NOT NULL,
  can_receive INTEGER NOT NULL DEFAULT 0 CHECK (can_receive IN (0, 1)),
  can_send INTEGER NOT NULL DEFAULT 0 CHECK (can_send IN (0, 1)),
  PRIMARY KEY (member_id, domain),
  CHECK (can_receive = 1 OR can_send = 1)
);
