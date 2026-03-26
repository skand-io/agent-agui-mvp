/**
 * AG-UI Minimal Example - Main App Component
 * Displays two-tier tool tracking: messages (Tier 1) and tool logs (Tier 2)
 * Live event stream indicator and thinking content display
 */

import { useState } from 'react';
import './App.css';
import { useChat } from './useChat';

// Human-readable labels for AG-UI event types
const EVENT_LABELS: Record<string, string> = {
  RUN_STARTED: 'Starting run',
  RUN_FINISHED: 'Run complete',
  RUN_ERROR: 'Error',
  STEP_STARTED: 'Step started',
  STEP_FINISHED: 'Step finished',
  THINKING_START: 'Thinking...',
  THINKING_END: 'Done thinking',
  THINKING_TEXT_MESSAGE_START: 'Reasoning...',
  THINKING_TEXT_MESSAGE_CONTENT: 'Reasoning...',
  THINKING_TEXT_MESSAGE_END: 'Done reasoning',
  TEXT_MESSAGE_START: 'Writing response...',
  TEXT_MESSAGE_CONTENT: 'Streaming text...',
  TEXT_MESSAGE_END: 'Response complete',
  TOOL_CALL_START: 'Calling tool...',
  TOOL_CALL_ARGS: 'Sending arguments...',
  TOOL_CALL_END: 'Tool call sent',
  TOOL_CALL_RESULT: 'Tool result received',
  STATE_SNAPSHOT: 'State snapshot',
  STATE_DELTA: 'State update',
  MESSAGES_SNAPSHOT: 'Messages snapshot',
  ACTIVITY_SNAPSHOT: 'Activity update',
  ACTIVITY_DELTA: 'Activity update',
  CUSTOM: 'Custom event',
};

export default function App() {
  const {
    messages,
    isLoading,
    sendMessage,
    agentState,
    currentEvent,
    thinkingContent,
  } = useChat();
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage(input);
      setInput('');
    }
  };

  return (
    <div className="app">
      <h1>AG-UI Minimal Example</h1>
      <p className="subtitle">Full AG-UI protocol with live event stream</p>

      {/* Live Event Indicator */}
      {currentEvent && (
        <div className="event-indicator" data-testid="event-indicator">
          <span className="event-dot" />
          <span className="event-type">{currentEvent}</span>
          <span className="event-label">
            {EVENT_LABELS[currentEvent] || currentEvent}
          </span>
        </div>
      )}

      {/* Thinking Content (from reasoning model) */}
      {thinkingContent && (
        <div className="thinking" data-testid="thinking">
          <div className="thinking-header">Reasoning</div>
          <div className="thinking-content">{thinkingContent}</div>
        </div>
      )}

      {/* Messages (Tier 1 - message-based tracking) */}
      <div className="messages" data-testid="messages">
        {messages
          .filter((msg) => msg != null)
          .map((msg, i) => (
            <div
              key={msg.id || i}
              className={`message message-${msg.role}`}
              data-testid={`message-${msg.role}`}
            >
              <div className="message-role">{msg.role}:</div>
              <div className="message-content">
                {'content' in msg && typeof msg.content === 'string' && msg.content}
              </div>
            </div>
          ))}
        {isLoading && !currentEvent && <div className="loading">Thinking...</div>}
      </div>

      {/* Tool Logs (Tier 2 - state-based tracking for UI progress) */}
      {agentState.tool_logs.length > 0 && (
        <div className="tool-logs" data-testid="tool-logs">
          <h3>Tool Progress</h3>
          {agentState.tool_logs.map((log) => (
            <div
              key={log.id}
              className={`tool-log tool-log-${log.status}`}
              data-testid={`tool-log-${log.id}`}
            >
              {log.status === 'processing' && '\u23F3'}
              {log.status === 'completed' && '\u2705'}
              {log.status === 'error' && '\u274C'}
              {' '}
              {log.message}
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <form className="input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Try: Get weather in Tokyo and greet Alice"
          disabled={isLoading}
          data-testid="message-input"
          className="message-input"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          data-testid="send-button"
          className="send-button"
        >
          Send
        </button>
      </form>
    </div>
  );
}
