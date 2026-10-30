-- Mails table (replaces KV mail:{id} + mail:index:*)
CREATE TABLE mails (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  reference_json TEXT NOT NULL DEFAULT '{}',
  folder TEXT NOT NULL DEFAULT 'inbox'
);

CREATE INDEX idx_mails_timestamp ON mails (timestamp DESC);
CREATE INDEX idx_mails_message_id ON mails (message_id);
CREATE INDEX idx_mails_folder_timestamp ON mails (folder, timestamp DESC);
