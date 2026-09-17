/**
 * Barrel export — tầng runtime agent dùng chung cho Vyen.
 *
 * Gói gồm 6 module độc lập, không phụ thuộc Dexie/React:
 * - event-stream: source of truth append-only cho mọi sự kiện phiên agent
 * - stuck-detector: phân loại vòng lặp vô nghĩa từ event stream
 * - condenser: nén ngữ cảnh theo policy (coalesce obs trùng + amortized forgetting)
 * - security: SecurityAnalyzer (risk classification) + AgentStateMachine
 * - observation: làm sạch terminal + cắt observation theo budget từng tool
 * - trajectory: export/import phiên (JSON/JSONL) + redaction + thống kê + diff
 */

export * from './event-stream';
export * from './stuck-detector';
export * from './condenser';
export * from './security';
export * from './observation';
export * from './trajectory';
