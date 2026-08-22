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
        <div className="mx-auto my-4 max-w-xl rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-xs text-red-600 dark:text-red-400 shadow-sm backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <div className="flex-1 space-y-1.5">
              <p className="font-semibold text-red-700 dark:text-red-300">
                Lỗi hiển thị nội dung tin nhắn
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {this.state.error?.message ||
                  "Đã xảy ra lỗi không mong muốn khi hiển thị phần này của cây tin nhắn."}
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={this.handleRetry}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 transition shadow-sm"
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
