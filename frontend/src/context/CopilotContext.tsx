import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { Message, CopilotAction, CopilotContextValue } from '../types';
import { useTree, type TreeNodeId } from '../hooks/useTree';

const CopilotContext = createContext<CopilotContextValue | null>(null);

// Default category for contexts (matches CopilotKit)
export const defaultCopilotContextCategories = ['global'];

interface CopilotProviderProps {
  children: React.ReactNode;
}

export function CopilotProvider({ children }: CopilotProviderProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actions, setActions] = useState<Map<string, CopilotAction>>(new Map());

  // Use tree for readable contexts (matches CopilotKit's approach)
  const { addElement, removeElement, printTree } = useTree();

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

  const addContext = useCallback(
    (context: string, parentId?: string, categories: string[] = defaultCopilotContextCategories): TreeNodeId => {
      return addElement(context, categories, parentId);
    },
    [addElement],
  );

  const removeContext = useCallback(
    (id: TreeNodeId): void => {
      removeElement(id);
    },
    [removeElement],
  );

  const getContextString = useCallback(
    (categories: string[] = defaultCopilotContextCategories): string => {
      return printTree(categories);
    },
    [printTree],
  );

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
      addContext,
      removeContext,
      getContextString,
    }),
    [messages, isLoading, actions, sendMessage, registerAction, unregisterAction, addContext, removeContext, getContextString]
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
