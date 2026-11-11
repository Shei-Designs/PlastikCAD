// Reading what went wrong, wherever it came from.
import { tr } from './i18n';

/**
 * What went wrong, as an Error with words in it. The native side rejects with
 * a string from Rust and with an object holding a `message` from an Android
 * plugin, neither of which reads as anything once it is shown or compared.
 */
export function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  const message = typeof reason === 'object' && reason !== null ? (reason as { message?: unknown }).message : undefined;
  if (typeof message === 'string' && message) return new Error(message);
  let text: string | undefined;
  try {
    text = JSON.stringify(reason);
  } catch {
    // Not something that can be written out.
  }
  return new Error(text && text !== '{}' && text !== 'null' ? text : tr('Something went wrong, and the system did not say what.'));
}
