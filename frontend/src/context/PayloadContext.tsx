import React, { createContext, useContext, useState, useCallback } from 'react';
import type { LLMPayload } from '../hooks/useChat';

interface PayloadContextValue {
  lastPayload: LLMPayload | null;
  setLastPayload: (payload: LLMPayload) => void;
}

const PayloadContext = createContext<PayloadContextValue | null>(null);

export function PayloadProvider({ children }: { children: React.ReactNode }) {
  const [lastPayload, setLastPayloadState] = useState<LLMPayload | null>(null);

  const setLastPayload = useCallback((payload: LLMPayload) => {
    setLastPayloadState(payload);
  }, []);

  return (
    <PayloadContext.Provider value={{ lastPayload, setLastPayload }}>
      {children}
    </PayloadContext.Provider>
  );
}

export function usePayloadContext(): PayloadContextValue {
  const context = useContext(PayloadContext);
  if (context === null) {
    throw new Error('usePayloadContext must be used within a PayloadProvider');
  }
  return context;
}
