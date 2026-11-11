import { useEffect, useRef, useState } from 'react';
import { marked, tr } from '../i18n';
import { answer, answerPick, useQuestion } from './ask';
import { Modal } from './Modal';

/** The box the questions in `ask.ts` are put in. */
export function AskDialog() {
  const question = useQuestion();
  const box = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  // The box is on show by the time this runs: a child's effects come before its parent's.
  useEffect(() => {
    if (question?.kind === 'name') {
      setText(question.value);
      // Offered selected, so a new name can be typed straight over it.
      setTimeout(() => box.current?.select(), 0);
    }
  }, [question]);
  // Which of a list are ticked, by their place in it; none whenever a new list is put up.
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setPicked(new Set()), [question]);
  const back = () => answer(null);
  return (
    <Modal open={Boolean(question)} onClose={back} className="ask" label={question?.title}>
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
              {tr('Cancel')}
            </button>
            <button type="submit" className="primary" disabled={text.trim() === ''}>
              {question.okLabel}
            </button>
          </div>
        </form>
      )}
      {question?.kind === 'pick' && (
        <form
          className="ask-body"
          onSubmit={(e) => {
            e.preventDefault();
            answerPick([...picked].sort((a, b) => a - b));
          }}
        >
          <h2>{question.title}</h2>
          <p>{question.text}</p>
          <ul className="ask-picks">
            {question.items.map((item, i) => (
              <li key={i}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setPicked(next);
                    }}
                  />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="ask-buttons">
            <button type="button" className="chip" onClick={back}>
              {tr('Skip')}
            </button>
            <button type="submit" className="primary" disabled={picked.size === 0}>
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
              // An action is the English its asker compares the answer with: it is translated here, where it is shown.
              <button key={action} type="button" className={i === all.length - 1 ? 'primary' : 'chip'} onClick={() => answer(action)}>
                {marked(action)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
