/**
 * AG-UI Minimal Example - Main App Component
 * Displays two-tier tool tracking: messages (Tier 1) and tool logs (Tier 2)
 */

import { useState } from 'react';
import './App.css';
import { useChat } from './useChat';

export default function App() {
  const { messages, isLoading, sendMessage, agentState, activity } = useChat();
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
      <p className="subtitle">Demonstrating all 21 AG-UI events + two-tier state sync</p>

      {/* Activity Indicator */}
      {activity && (
        <div className="activity" data-testid="activity">
          <strong>Status:</strong> {activity.status}
          {activity.progress !== undefined && ` (${activity.progress}%)`}
        </div>
      )}

      {/* Messages (Tier 1 - message-based tracking) */}
      <div className="messages" data-testid="messages">
        {messages.filter(msg => msg != null).map((msg, i) => (
          <div
            key={msg.id || i}
            className={`message message-${msg.role}`}
            data-testid={`message-${msg.role}`}
          >
            <div className="message-role">{msg.role}:</div>
            <div className="message-content">
              {'content' in msg && typeof msg.content === 'string' && msg.content}

              {/* Display tool calls from assistant messages
              {msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {msg.toolCalls.map((tc) => (
                    <div
                      key={tc.id}
                      className="tool-call"
                      data-testid={`tool-call-${tc.function.name}`}
                    >
                      📞 {tc.function.name}({tc.function.arguments})
                    </div>
                  ))}
                </div>
              )} */}
            </div>
          </div>
        ))}
        {isLoading && <div className="loading">Thinking...</div>}
      </div>

      {/* Tool Logs (Tier 2 - state-based tracking for UI progress) */}
      {agentState.tool_logs.length > 0 && (
        <div className="tool-logs" data-testid="tool-logs">
          <h3>Tool Progress (State-Based Tracking)</h3>
          {agentState.tool_logs.map((log) => (
            <div
              key={log.id}
              className={`tool-log tool-log-${log.status}`}
              data-testid={`tool-log-${log.id}`}
            >
              {log.status === 'processing' && '⏳'}
              {log.status === 'completed' && '✅'}
              {log.status === 'error' && '❌'}
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

      <div className="instructions">
        <strong>Instructions:</strong> Open browser console to see all 21 AG-UI events logged with emoji
      </div>
    </div>
  );
}
