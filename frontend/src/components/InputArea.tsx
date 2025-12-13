import { useState, KeyboardEvent } from 'react';
import styles from './InputArea.module.css';

interface InputAreaProps {
  onSend: (message: string) => void;
  isLoading: boolean;
}

export function InputArea({ onSend, isLoading }: InputAreaProps) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (input.trim() && !isLoading) {
      onSend(input);
      setInput('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSend();
    }
  };

  return (
    <div className={styles.inputArea} data-testid="input-area">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Try: 'Greet Alice' or 'What's the weather in Tokyo?'"
        disabled={isLoading}
        className={styles.input}
        data-testid="message-input"
      />
      <button
        onClick={handleSend}
        disabled={isLoading || !input.trim()}
        className={styles.button}
        data-testid="send-button"
      >
        Send
      </button>
    </div>
  );
}
