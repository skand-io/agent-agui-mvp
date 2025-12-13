import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import type { Message, CopilotAction, CopilotContextValue } from '../types';

const CopilotContext = createContext<CopilotContextValue | null>(null);

interface ReadableContext {
  id: string;
  content: string;
  parentId?: string;
}

interface CopilotProviderProps {
  children: React.ReactNode;
}

let contextIdCounter = 0;

export function CopilotProvider({ children }: CopilotProviderProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actions, setActions] = useState<Map<string, CopilotAction>>(new Map());
  const readableContextsRef = useRef<Map<string, ReadableContext>>(new Map());

  const registerAction = useCallback((action: CopilotAction) => {
    setActions((prev) => {
      const next = new Map(prev);
      next.set(action.name, action);
      return next;
    });
  }, []);

  const unregisterAction = useCallback((name: string) => {
    setActions((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const addReadableContext = useCallback((content: string, parentId?: string): string => {
    const id = `ctx_${++contextIdCounter}`;
    readableContextsRef.current.set(id, { id, content, parentId });
    return id;
  }, []);

  const removeReadableContext = useCallback((id: string) => {
    readableContextsRef.current.delete(id);
  }, []);

  const getContextString = useCallback((): string => {
    const contexts = Array.from(readableContextsRef.current.values());
    if (contexts.length === 0) return '';

    // Build hierarchical context string
    const rootContexts = contexts.filter(c => !c.parentId);
    const childContexts = contexts.filter(c => c.parentId);

    const buildContextTree = (context: ReadableContext, indent = 0): string => {
      const prefix = '  '.repeat(indent);
      const children = childContexts.filter(c => c.parentId === context.id);
      const childrenStr = children.map(c => buildContextTree(c, indent + 1)).join('\n');
      return `${prefix}- ${context.content}${childrenStr ? '\n' + childrenStr : ''}`;
    };

    return rootContexts.map(c => buildContextTree(c)).join('\n');
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    // TODO: Implement actual message sending logic
    // This will be fleshed out when we integrate with useChat
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: 'user', content }]);
    setIsLoading(false);
  }, []);

  const value = useMemo<CopilotContextValue>(
    () => ({
      messages,
      isLoading,
      actions,
      sendMessage,
      registerAction,
      unregisterAction,
      addReadableContext,
      removeReadableContext,
      getContextString,
    }),
    [messages, isLoading, actions, sendMessage, registerAction, unregisterAction, addReadableContext, removeReadableContext, getContextString]
  );

  return (
    <CopilotContext.Provider value={value}>
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilotContext(): CopilotContextValue {
  const context = useContext(CopilotContext);
  if (context === null) {
    throw new Error('useCopilotContext must be used within a CopilotProvider');
  }
  return context;
}
