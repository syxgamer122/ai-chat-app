'use client';

import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * Đổi giá trị này để tự xoá trạng thái lỗi (vd: nội dung message).
   * Không có nó, một lần render lỗi là bubble kẹt ở fallback mãi mãi —
   * kể cả khi content đầy đủ/correct đã về, vì instance giữ nguyên theo
   * key (message id) của list ảo.
   */
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
  error?: Error;
  lastResetKey?: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, lastResetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.hasError && props.resetKey !== state.lastResetKey) {
      return { hasError: false, lastResetKey: props.resetKey };
    }
    if (!state.hasError && props.resetKey !== state.lastResetKey) {
      return { lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="notice-error">
            Lỗi hiển thị nội dung. Vui lòng tải lại hoặc thử lại tin nhắn.
          </div>
        )
      );
    }

    return this.props.children;
  }
}
