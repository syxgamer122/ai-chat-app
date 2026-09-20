"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCcw, AlertTriangle } from "lucide-react";

interface ChatErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ChatErrorBoundary extends Component<
  ChatErrorBoundaryProps,
  ChatErrorBoundaryState
> {
  state: ChatErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[chat-tree] render error caught:", error, errorInfo);
  }

  handleRetry = () => {
    this.props.onReset?.();
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          role="alert"
          className="mx-auto my-4 max-w-xl rounded-none border border-status-error/40 bg-surface-raised p-4 text-xs font-mono text-text-primary"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" />
            <div className="flex-1 space-y-1.5">
              <p className="font-semibold text-status-error">
                Lỗi hiển thị nội dung tin nhắn
              </p>
              <p className="text-text-muted">
                {this.state.error?.message ||
                  "Đã xảy ra lỗi không mong muốn khi hiển thị phần này của cây tin nhắn."}
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={this.handleRetry}
                  className="btn-secondary inline-flex items-center gap-1.5 border border-status-error/40 text-status-error hover:bg-[#e8704f]/10 px-3 py-1.5 font-medium"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  <span>Thử lại</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
