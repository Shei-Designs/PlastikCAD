import { useEffect, useRef, useState } from 'react';
import { answer, useQuestion } from './ask';

/** The box the questions in `ask.ts` are put in. */
export function AskDialog() {
  const question = useQuestion();
  const dialog = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (question && !d.open) d.showModal();
    else if (!question && d.open) d.close();
    if (question?.kind === 'name') {
      setText(question.value);
      // Offered selected, so a new name can be typed straight over it.
      setTimeout(() => box.current?.select(), 0);
    }
  }, [question]);
  const back = () => answer(null);
  return (
    <dialog
      ref={dialog}
      className="ask"
      aria-label={question?.title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        back();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) back();
      }}
    >
      {question?.kind === 'name' && (
        <form
          className="ask-body"
          onSubmit={(e) => {
            e.preventDefault();
            answer(text);
          }}
        >
          <h2>{question.title}</h2>
          <label className="ask-field">
            <span>{question.label}</span>
            <span className="ask-name">
              <input ref={box} className="text-input" type="text" value={text} autoComplete="off" spellCheck={false} onChange={(e) => setText(e.target.value)} />
              {question.suffix && <span className="ask-suffix">{question.suffix}</span>}
            </span>
          </label>
          <div className="ask-buttons">
            <button type="button" className="chip" onClick={back}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={text.trim() === ''}>
              {question.okLabel}
            </button>
          </div>
        </form>
      )}
      {question?.kind === 'choice' && (
        <div className="ask-body">
          <h2>{question.title}</h2>
          <p>{question.text}</p>
          {question.lines && question.lines.length > 0 && (
            <ul className="ask-lines">
              {question.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <div className="ask-buttons">
            {[...question.actions].reverse().map((action, i, all) => (
              <button key={action} type="button" className={i === all.length - 1 ? 'primary' : 'chip'} onClick={() => answer(action)}>
                {action}
              </button>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );
}
