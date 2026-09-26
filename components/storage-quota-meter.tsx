'use client';

/**
 * StorageQuotaMeter — Giám sát dung lượng IndexedDB & trạng thái Storage Persistence.
 */

import { useState, useEffect } from 'react';
import { HardDrive, ShieldCheck, AlertCircle, RefreshCw, Database } from 'lucide-react';

export function StorageQuotaMeter() {
  const [usage, setUsage] = useState<number>(0);
  const [quota, setQuota] = useState<number>(0);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const checkStorage = async () => {
    if (typeof navigator === 'undefined' || !navigator.storage) return;

    setLoading(true);
    try {
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        setUsage(est.usage ?? 0);
        setQuota(est.quota ?? 0);
      }

      if (navigator.storage.persisted) {
        const isPersisted = await navigator.storage.persisted();
        setPersisted(isPersisted);
      }
    } catch (err) {
      console.error('Storage quota check failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestPersist = async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    try {
      const granted = await navigator.storage.persist();
      setPersisted(granted);
    } catch (err) {
      console.error('Request storage persistence failed:', err);
    }
  };

  useEffect(() => {
    checkStorage();
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const percentage = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
  const isHigh = percentage >= 70;
  const isCritical = percentage >= 90 || persisted === false;

  return (
    <div className="border border-border-hairline bg-surface-raised p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-status-info" />
          <h4 className="text-xs font-semibold text-text-primary">Dung Lượng Bộ Nhớ &amp; Độ Bền Vững (Storage Quota)</h4>
        </div>
        <button
          onClick={checkStorage}
          className="p-1 text-text-muted hover:text-text-primary rounded hover:bg-surface"
          title="Kiểm tra lại dung lượng"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="space-y-2 mt-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted flex items-center gap-1.5">
            <Database size={12} /> Đã dùng: {formatBytes(usage)} / {formatBytes(quota)}
          </span>
          <span className="font-mono text-text-primary">{percentage}%</span>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden border border-border-hairline">
          <div
            className={`h-full transition-all duration-300 ${
              isCritical ? 'bg-status-error' : isHigh ? 'bg-status-warning' : 'bg-status-success'
            }`}
            style={{ width: `${Math.max(2, percentage)}%` }}
          />
        </div>

        {/* Persistence Status */}
        <div className="flex items-center justify-between pt-1 text-[11px]">
          <div className="flex items-center gap-1.5">
            {persisted ? (
              <span className="text-status-success flex items-center gap-1">
                <ShieldCheck size={12} /> Bảo vệ chống browser eviction: ĐÃ BẬT
              </span>
            ) : (
              <span className="text-status-warning flex items-center gap-1">
                <AlertCircle size={12} /> Chưa được cấp quyền bảo vệ vĩnh viễn
              </span>
            )}
          </div>

          {!persisted && (
            <button
              onClick={handleRequestPersist}
              className="text-[10px] text-primary hover:underline font-medium"
            >
              Yêu cầu bảo vệ
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
