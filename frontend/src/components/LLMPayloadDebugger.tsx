import { useState } from 'react';
import { usePayloadContext } from '../context/PayloadContext';
import styles from './LLMPayloadDebugger.module.css';

// Recreate the backend's context injection logic for display purposes
function buildPlainTextPrompt(payload: {
  messages: Array<{ role: string; content: string }>;
  context?: string;
}): string {
  const { messages, context } = payload;
  const lines: string[] = [];

  if (!messages.length) {
    return '(No messages)';
  }

  // Find the index of the last user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  // Build messages, injecting context before the last user message (like backend does)
  for (let i = 0; i < messages.length; i++) {
    // Inject context right before the last user message
    if (i === lastUserIdx && context) {
      lines.push('--- [SYSTEM] ---');
      lines.push('[CURRENT APPLICATION CONTEXT]');
      lines.push('This is the current state of the application. It is injected fresh each turn and reflects the CURRENT state.');
      lines.push('Important: This context may have changed since earlier messages. Always use this current context, not any previously mentioned state.');
      lines.push('');
      lines.push(context);
      lines.push('');
    }

    const msg = messages[i];
    const roleLabel = msg.role.toUpperCase();
    lines.push(`--- [${roleLabel}] ---`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

export function LLMPayloadDebugger() {
  const { lastPayload } = usePayloadContext();
  const [viewMode, setViewMode] = useState<'plain' | 'json'>('plain');

  if (!lastPayload) {
    return (
      <div className={styles.container}>
        <h3 className={styles.title}>LLM Payload</h3>
        <div className={styles.subtitle}>
          Send a message to see the full payload sent to the LLM
        </div>
        <pre className={styles.payload}>(No payload yet)</pre>
      </div>
    );
  }

  const plainText = buildPlainTextPrompt(lastPayload);

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>LLM Payload</h3>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${viewMode === 'plain' ? styles.activeTab : ''}`}
          onClick={() => setViewMode('plain')}
        >
          Plain Text
        </button>
        <button
          className={`${styles.tab} ${viewMode === 'json' ? styles.activeTab : ''}`}
          onClick={() => setViewMode('json')}
        >
          JSON
        </button>
      </div>
      <div className={styles.subtitle}>
        {viewMode === 'plain'
          ? 'Messages as seen by the LLM (with context injected):'
          : 'Full request body sent to /chat endpoint:'
        }
      </div>
      <pre className={styles.payload}>
        {viewMode === 'plain'
          ? plainText
          : JSON.stringify(lastPayload, null, 2)
        }
      </pre>
    </div>
  );
}
