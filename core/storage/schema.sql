-- ====================================================================
-- VYEN ENTERPRISE SQLITE SCHEMA (WAL MODE + RECURSIVE CTE + FTS5)
-- ====================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Bảng Phiên Chat (Sessions)
CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    active_leaf_id TEXT,
    workspace_path TEXT,
    revision INTEGER DEFAULT 1
);

-- 2. Bảng Cây Tin Nhắn (Hierarchical Message Tree)
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    parent_id TEXT NOT NULL, -- '__ROOT__' cho tin nhắn gốc
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    reasoning TEXT,
    tool_calls TEXT,      -- JSON Array
    tool_results TEXT,    -- JSON Array
    usage_tokens TEXT,    -- JSON Object
    created_at INTEGER NOT NULL,
    FOREIGN KEY(chat_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_tree ON messages(chat_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);

-- 3. Bảng FTS5 Tìm Kiếm Toàn Văn Siêu Tốc (Full-Text Search)
-- Sử dụng tokenizer unicode61 loại bỏ dấu tiếng Việt
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    reasoning,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers tự động đồng bộ sang FTS5
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, reasoning)
    VALUES (new.rowid, new.content, COALESCE(new.reasoning, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, reasoning)
    VALUES('delete', old.rowid, old.content, COALESCE(old.reasoning, ''));
END;

-- 4. Bảng Audit Log Bất Biến Hash Chain
CREATE TABLE IF NOT EXISTS audit_logs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_summary TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    prev_hash TEXT,
    status TEXT NOT NULL
);

-- 5. Bảng Distributed Fencing Tokens chống Split-Brain
CREATE TABLE IF NOT EXISTS fencing_tokens (
    chat_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
