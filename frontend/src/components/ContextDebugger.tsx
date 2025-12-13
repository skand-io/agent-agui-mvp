import { useCopilotContext } from '../context/CopilotContext';
import styles from './ContextDebugger.module.css';

export function ContextDebugger() {
  const { getContextString } = useCopilotContext();
  const contextString = getContextString();

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Current Context</h3>
      <div className={styles.subtitle}>
        This is what the AI sees about your app state:
      </div>
      <pre className={styles.context}>
        {contextString || '(No context registered)'}
      </pre>
    </div>
  );
}
