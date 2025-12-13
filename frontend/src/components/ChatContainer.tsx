import { useRef, useEffect } from 'react';
import { useChatWithContext } from '../hooks/useChat';
import { Message } from './Message';
import { InputArea } from './InputArea';
import { Loading } from './Loading';
import styles from './ChatContainer.module.css';

export function ChatContainer() {
  const { messages, isLoading, sendMessage } = useChatWithContext();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const showLoadingIndicator =
    isLoading && messages[messages.length - 1]?.role !== 'assistant';

  return (
    <div className={styles.container} data-testid="chat-container">
      <div className={styles.header}>
        AG-UI Demo
        <span className={styles.badge}>AG-UI Protocol</span>
      </div>
      <div className={styles.info}>
        <strong>Frontend tools:</strong> greet, setTheme |{' '}
        <strong>Backend tools:</strong> get_weather, calculate
      </div>
      <div className={styles.messages} data-testid="messages">
        {messages.map((msg, i) => (
          <Message key={i} message={msg} />
        ))}
        {showLoadingIndicator && (
          <div
            className={`${styles.messageWrapper} ${styles.assistant}`}
            data-testid="loading-indicator"
          >
            <Loading />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <InputArea onSend={sendMessage} isLoading={isLoading} />
    </div>
  );
}
