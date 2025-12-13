import { useState } from 'react';
import { useCopilotReadable } from '../hooks/useCopilotReadable';
import styles from './ColorPicker.module.css';

type Color = 'red' | 'blue' | 'green';

export function ColorPicker() {
  const [selectedColor, setSelectedColor] = useState<Color>('red');

  // This automatically handles add/remove context when selectedColor changes
  useCopilotReadable({
    description: "User's selected favorite color",
    value: selectedColor,
  });

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Pick your favorite color:</h3>
      <div className={styles.options}>
        {(['red', 'blue', 'green'] as Color[]).map((color) => (
          <label key={color} className={styles.option}>
            <input
              type="radio"
              name="color"
              value={color}
              checked={selectedColor === color}
              onChange={() => setSelectedColor(color)}
              className={styles.radio}
            />
            <span
              className={styles.colorLabel}
              style={{ color }}
            >
              {color}
            </span>
          </label>
        ))}
      </div>
      <div className={styles.hint}>
        Try asking the AI: "What is my favorite color?"
      </div>
    </div>
  );
}
