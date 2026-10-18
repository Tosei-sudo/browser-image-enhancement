/**
 * The message line at the bottom right of the page. One message at a time;
 * while many files open together (a batch), their messages are not shown one
 * by one: the line says how far the batch has got, and what went wrong or
 * needs a look is counted, with the messages themselves in a list that opens
 * from the line (詳細).
 */

/**
 * What a message is: `progress` (something being done, ending in …),
 * `done` (a file opened as expected), `error` (a file could not be opened) or
 * `note` (anything else worth reading).
 */
export type SayKind = 'progress' | 'done' | 'error' | 'note';

/** How long a message said during a batch stays before the batch's line comes back. */
const MESSAGE_MS = 3000;

/** Names listed in full in a message; the rest are counted. */
const NAMES_SHOWN = 3;

/** `names` joined for a message: the first few, and how many more (「a、b、c ほか 7 件」). */
export function nameList(names: readonly string[], shown = NAMES_SHOWN): string {
  if (names.length <= shown + 1) return names.join('、');
  return `${names.slice(0, shown).join('、')} ほか ${(names.length - shown).toLocaleString()} 件`;
}

/** The kind of a message given without one: progress when it ends in … (or a percentage after it), an error when a file could not be opened, done when one opened as expected. */
export function kindOf(message: string): SayKind {
  if (/…\s*(\d+%)?$/.test(message)) return 'progress';
  if (/を(開け|読め)ませんでした/.test(message)) return 'error';
  // Opened as expected (a vector layer, editable).
  return /を開きました(（✎ で編集できます）)?$/.test(message) ? 'done' : 'note';
}

/** Files opening together, as the status line shows them. */
export interface StatusBatch {
  /** How many of the files are done. */
  progress(done: number): void;
  /** Ends the batch; `message` (what was opened) leads its line from then on, and `problems` are counted with the files not opened. */
  end(message?: string, problems?: readonly string[]): void;
}

interface Batch {
  /** What the line says while the batch runs, in place of the count. */
  label: string | null;
  total: number;
  done: number;
  running: boolean;
  summary: string | null;
  errors: string[];
  notes: string[];
}

export class StatusLine {
  private readonly text_ = document.createElement('span');
  private readonly more_ = document.createElement('button');
  private readonly list_ = document.createElement('ul');
  private batch_: Batch | null = null;
  /** A message said during a batch, shown for a while before the batch's line. */
  private message_: string | null = null;
  private messageTimer_ = 0;

  constructor(readonly element: HTMLElement) {
    this.text_.className = 'status-text';
    this.text_.setAttribute('role', 'status');
    this.more_.type = 'button';
    this.more_.className = 'status-more';
    this.more_.hidden = true;
    this.more_.setAttribute('aria-expanded', 'false');
    this.list_.className = 'status-details';
    this.list_.hidden = true;
    this.list_.setAttribute('aria-label', '読み込みの詳細');
    this.more_.addEventListener('click', () => this.toggle_());
    element.replaceChildren(this.list_, this.text_, this.more_);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.list_.hidden) this.toggle_(false);
    });
  }

  /** The line's text, as shown. */
  get text(): string {
    return this.text_.textContent ?? '';
  }

  /** Says `message`, in place of what the line said (a finished batch included). */
  say(message: string): void {
    if (this.batch_?.running) {
      // The batch's line comes back after a while.
      this.message_ = message;
      clearTimeout(this.messageTimer_);
      this.messageTimer_ = window.setTimeout(() => {
        this.message_ = null;
        this.render_();
      }, MESSAGE_MS);
    } else {
      this.batch_ = null;
      this.message_ = message;
    }
    this.render_();
  }

  /**
   * Says a message about opening files: while a batch runs (or its line is
   * still shown), it goes to the batch, which counts it rather than showing
   * it; otherwise it is said as it is.
   */
  sayForFiles(message: string, kind: SayKind = kindOf(message)): void {
    const batch = this.batch_;
    // After a batch, a file opening (or opened) on its own is said as usual; problems found later (an RSET that could not be made) join the batch's.
    if (!batch || (!batch.running && (kind === 'progress' || kind === 'done'))) return this.say(message);
    if (kind === 'error') batch.errors.push(message);
    else if (kind === 'note') batch.notes.push(message);
    // Progress and files opened are what the batch's count says.
    else return;
    this.render_();
  }

  /**
   * Starts a batch of `total` files: their messages are counted from here on
   * (see {@link sayForFiles}). With a `label`, the line says it while the
   * batch runs, in place of how many files are done.
   */
  begin(total: number, label?: string): StatusBatch {
    const batch: Batch = { label: label ?? null, total, done: 0, running: true, summary: null, errors: [], notes: [] };
    this.batch_ = batch;
    this.message_ = null;
    clearTimeout(this.messageTimer_);
    this.toggle_(false);
    this.render_();
    return {
      progress: (done) => {
        batch.done = done;
        if (this.batch_ === batch) this.render_();
      },
      end: (message, problems = []) => {
        batch.running = false;
        batch.summary = message ?? null;
        batch.errors.push(...problems.map((p) => `開けなかったもの: ${p}`));
        if (this.batch_ !== batch) return;
        // A message said during the batch gives way to how it ended.
        this.message_ = null;
        clearTimeout(this.messageTimer_);
        this.render_();
      },
    };
  }

  private render_(): void {
    const batch = this.batch_;
    const showBatch = batch && this.message_ === null;
    const text = showBatch ? batchText(batch) : (this.message_ ?? '');
    this.text_.textContent = text;
    // Cut to two lines by the style sheet: the whole of it on hover.
    this.text_.title = text;
    const count = batch ? batch.errors.length + batch.notes.length : 0;
    // One message is in the line itself once the batch is over.
    this.more_.hidden = !showBatch || !count || (!batch.running && count === 1);
    // Nothing of it in the line's text while hidden.
    this.more_.textContent = this.more_.hidden ? '' : `詳細（${count.toLocaleString()}）`;
    if (this.more_.hidden) this.toggle_(false);
    else if (!this.list_.hidden) this.fill_();
  }

  private toggle_(open = this.list_.hidden): void {
    this.list_.hidden = !open;
    this.more_.setAttribute('aria-expanded', String(open));
    if (open) this.fill_();
    else this.list_.replaceChildren();
  }

  private fill_(): void {
    const batch = this.batch_;
    if (!batch) return;
    const item = (message: string, className: string) => Object.assign(document.createElement('li'), { className, textContent: message });
    this.list_.replaceChildren(...batch.errors.map((m) => item(m, 'status-error')), ...batch.notes.map((m) => item(m, 'status-note')));
  }
}

/** A batch's line: how far it has got (or how it ended), and what went wrong. */
function batchText(batch: Batch): string {
  const lead = batch.running && batch.label ? batch.label : batch.running ? `${batch.total.toLocaleString()} 件を読み込み中 ${batch.done.toLocaleString()}/${batch.total.toLocaleString()}` : (batch.summary ?? `${batch.total.toLocaleString()} 件を読み込みました`);
  const one = !batch.running && batch.errors.length + batch.notes.length === 1 ? [...batch.errors, ...batch.notes][0] : null;
  if (one) return `${lead}（${one}）`;
  const counts = [batch.errors.length ? `開けなかったもの ${batch.errors.length.toLocaleString()} 件` : '', batch.notes.length ? `確認 ${batch.notes.length.toLocaleString()} 件` : ''].filter(Boolean);
  return counts.length ? `${lead}（${counts.join('・')}）` : lead;
}
