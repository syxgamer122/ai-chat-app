'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from 'ai/react';
import { useAppStore } from '@/lib/store';
import { db } from '@/lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { MarkdownRenderer } from './markdown-renderer';
import { motion, AnimatePresence } from 'framer-motion';
import TextareaAutosize from 'react-textarea-autosize';
import { Send, StopCircle, RefreshCcw, ArrowDown, Paperclip, X } from 'lucide-react';

export default function ChatInterface() {
  const { currentChatId, settings, setCurrentChatId } = useAppStore();
  const [autoScroll, setAutoScroll] = useState(true);
  const [attachments, setAttachments] = useState<File[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const initialMessages = useLiveQuery(
    () => currentChatId ? db.messages.where('chatId').equals(currentChatId).sortBy('createdAt') : [],
    [currentChatId]
  );

  const { messages, input, handleInputChange, handleSubmit, stop, reload, isLoading, error } = useChat({
    id: currentChatId || 'new',
    initialMessages: initialMessages || [],
    body: {
      model: settings.model,
      temperature: settings.temperature,
      system: settings.systemPrompt,
    },
    onFinish: async (message) => {
      if (!currentChatId) return;
      await db.messages.put({ ...message, chatId: currentChatId, createdAt: Date.now() });
      await db.chats.update(currentChatId, { updatedAt: Date.now() });
    },
    onError: (err) => console.error(err)
  });

  useEffect(() => {
    if (messages.length === 2 && currentChatId) {
      db.chats.get(currentChatId).then(chat => {
        if (chat && chat.title === 'New Chat') {
          fetch('/api/title', {
            method: 'POST',
            body: JSON.stringify({ message: messages[0].content })
          }).then(res => res.json()).then(data => {
            db.chats.update(currentChatId, { title: data.title });
          });
        }
      });
    }
  }, [messages, currentChatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (el) {
      const isBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
      setAutoScroll(isBottom);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() && attachments.length === 0 || isLoading) return;
    
    let chatId = currentChatId;
    if (!chatId) {
      chatId = crypto.randomUUID();
      setCurrentChatId(chatId);
      await db.chats.put({ id: chatId, title: 'New Chat', pinned: false, createdAt: Date.now(), updatedAt: Date.now() });
    }

    // Convert files to base64 for local saving
    const processedAttachments = await Promise.all(
      attachments.map(async (file) => {
        return new Promise<{ name: string, contentType: string, url: string }>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve({ name: file.name, contentType: file.type, url: e.target?.result as string });
          reader.readAsDataURL(file);
        });
      })
    );

    const userMsgId = crypto.randomUUID();
    await db.messages.put({ 
      id: userMsgId, 
      chatId, 
      role: 'user', 
      content: input, 
      createdAt: Date.now(),
      experimental_attachments: processedAttachments.length > 0 ? processedAttachments : undefined
    });
    
    // Create a FileList-like object or DataTransfer to pass to handleSubmit
    const dataTransfer = new DataTransfer();
    attachments.forEach(file => dataTransfer.items.add(file));
    
    setAttachments([]); // Clear attachments UI
    handleSubmit(e, { experimental_attachments: dataTransfer.files });
  };

  return (
    <div className="flex-1 flex flex-col relative h-full">
      {/* Khu vực hiển thị tin nhắn */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 pb-40 scroll-smooth">
        
        {/* Nếu không có tin nhắn nào -> Hiển thị Màn hình chào mừng */}
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pt-10 space-y-8">
            <div className="w-16 h-16 bg-indigo-500/10 rounded-2xl flex items-center justify-center text-indigo-500 mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </div>
            <h1 className="text-2xl font-medium text-zinc-200">How can I help you today?</h1>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl">
              {['Explain quantum computing', 'Write a Python script for scraping', 'Plan a healthy meal', 'Summarize an article'].map((prompt) => (
                <button key={prompt} onClick={() => handleInputChange({ target: { value: prompt } } as any)} className="p-4 text-left border border-zinc-800 rounded-xl hover:bg-zinc-900 transition-all text-sm text-zinc-400 hover:text-zinc-200">
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Nếu có tin nhắn -> Render danh sách tin nhắn */
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div key={m.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={`flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[720px] w-full p-5 rounded-2xl ${m.role === 'user' ? 'bg-zinc-800/80 text-zinc-100 ml-auto' : 'bg-transparent text-zinc-200'}`}>
                  
                  {/* Hiển thị file/ảnh đính kèm */}
                  {m.experimental_attachments && m.experimental_attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {m.experimental_attachments.map((attachment: any, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          {attachment.contentType?.startsWith('image/') ? (
                            <img src={attachment.url} alt={attachment.name || 'Image'} className="w-40 rounded-xl object-contain bg-zinc-900 border border-zinc-700" />
                          ) : (
                            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 p-2.5 rounded-xl text-sm">
                              <Paperclip size={16} />
                              <span className="truncate max-w-[150px]">{attachment.name || 'File'}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {m.role === 'assistant' ? <MarkdownRenderer content={m.content} /> : <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>}
                  
                  {m.role === 'assistant' && !isLoading && (
                    <div className="mt-3 flex items-center gap-2 opacity-0 hover:opacity-100 transition-opacity">
                      <button onClick={() => navigator.clipboard.writeText(m.content)} className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded"><RefreshCcw size={14} /></button>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
                <div className="max-w-[720px] p-5">
                  <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
        
        {error && (
          <div className="max-w-[720px] p-4 bg-red-950/50 border border-red-900 text-red-400 rounded-xl mx-auto flex items-center justify-between">
            <span>{error.message || 'An error occurred.'}</span>
            <button onClick={() => reload()} className="px-3 py-1 bg-red-900/50 rounded hover:bg-red-800 transition">Thử lại</button>
          </div>
        )}
      </div>

      {!autoScroll && (
        <button onClick={() => setAutoScroll(true)} className="absolute bottom-32 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition">
          <ArrowDown size={18} />
        </button>
      )}

      {/* Khu vực Input luôn luôn hiển thị ở dưới */}
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-10">
        <div className="max-w-[720px] mx-auto relative">
          
          {/* Preview Attachments */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 p-2 bg-zinc-900/80 border border-zinc-800 rounded-xl backdrop-blur-sm">
              {attachments.map((file, i) => (
                <div key={i} className="relative flex items-center gap-2 bg-zinc-800 p-2 rounded-lg text-xs text-zinc-300">
                  {file.type.startsWith('image/') ? (
                    <img src={URL.createObjectURL(file)} alt={file.name} className="w-8 h-8 object-cover rounded" />
                  ) : (
                    <Paperclip size={14} className="text-zinc-500" />
                  )}
                  <span className="truncate max-w-[120px]">{file.name}</span>
                  <button type="button" onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))} className="absolute -top-1.5 -right-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-full p-0.5">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={onSubmit} className="relative bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden focus-within:border-indigo-500/50 transition-colors shadow-sm">
            
            <input 
              type="file" 
              multiple 
              className="hidden" 
              ref={fileInputRef} 
              onChange={(e) => {
                if (e.target.files) setAttachments(prev => [...prev, ...Array.from(e.target.files!)]);
                e.target.value = ''; // Reset
              }} 
            />

            <button type="button" onClick={() => fileInputRef.current?.click()} className="absolute left-3 bottom-3 p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-xl transition-colors">
              <Paperclip size={18} />
            </button>

            <TextareaAutosize
              value={input}
              onChange={handleInputChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder="Gửi tin nhắn..."
              className="w-full max-h-[200px] bg-transparent text-zinc-100 placeholder:text-zinc-600 resize-none outline-none p-4 pl-14 pr-16 py-5"
              minRows={1}
              maxRows={8}
            />
            <div className="absolute right-3 bottom-3 flex items-center gap-2">
              {isLoading ? (
                <button type="button" onClick={stop} className="p-2 bg-zinc-800 text-zinc-300 rounded-xl hover:text-red-400 transition-colors">
                  <StopCircle size={18} />
                </button>
              ) : (
                <button type="submit" disabled={!input.trim() && attachments.length === 0} className="p-2 bg-indigo-600 text-white rounded-xl disabled:opacity-50 disabled:bg-zinc-800 transition-colors">
                  <Send size={18} />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}