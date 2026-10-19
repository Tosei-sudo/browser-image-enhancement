/**
 * 「スクリプト」 (ツール): analysis and editing written in JavaScript, like
 * arcpy in ArcGIS. A sample to start from, the editor, 「実行」 and
 * 「停止」, and what the script prints. Scripts run apart from the page
 * (script/sandbox.ts) and reach the viewer only through `viewer.*` and
 * `geo.*` (script/api.ts); what they edit waits for 「保存」 on the edit
 * toolbar like any other edit.
 *
 * A script only runs when 「実行」 is pressed here: nothing runs by itself
 * from a project file, a link or the browser's storage. With 「繰り返し」 set,
 * 「実行」 runs the script again at that interval while the page is open
 * (until 「停止」); 「実行の記録」 lists each run. Scripts are kept in this
 * browser (localStorage) and in project files, and can be opened from and
 * saved to .js files.
 */
import { ScriptRun, type ScriptHandlers } from './script/sandbox.js';
import { scriptHandlers, type ScriptContext } from './script/api.js';
import { SAMPLES } from './script/samples.js';
import { download } from './local-edit.js';
import { highlight } from './script/highlight.js';
import { ENTRIES, Suggest, type Choice } from './script/suggest.js';

import { mergeScripts, readSaved, writeSaved, type SavedScript } from './script/saved.js';

const DRAFT_KEY = 'image-viewer.script-draft';

/** The choices of 「繰り返し」, in seconds (0: run once). */
const REPEATS: [number, string][] = [
  [0, '1回だけ'],
  [30, '30秒ごと'],
  [60, '1分ごと'],
  [300, '5分ごと'],
  [600, '10分ごと'],
  [1800, '30分ごと'],
  [3600, '1時間ごと'],
  [10800, '3時間ごと'],
  [86400, '1日ごと'],
];

/** How many runs 「実行の記録」 keeps. */
const LOG_SIZE = 100;

const clock = (time: Date) => time.toLocaleTimeString('ja-JP', { hour12: false });

/** Runs of the script again and again: what runs, how often, and the timer of the next run. */
interface Repeat {
  code: string;
  name: string;
  seconds: number;
  timer: number;
  next: Date | null;
  /** Runs started so far. */
  runs: number;
}

export class ScriptDialog {
  readonly dialog: HTMLDialogElement;
  private readonly code_: HTMLTextAreaElement;
  /** The coloured copy of the script drawn under the (transparent) text of the editor. */
  private readonly highlight_: HTMLPreElement;
  private readonly choice_: HTMLSelectElement;
  private readonly output_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly progress_: HTMLProgressElement;
  private readonly run_: HTMLButtonElement;
  private readonly stop_: HTMLButtonElement;
  private readonly delete_: HTMLButtonElement;
  /** The toolbar button: it shows when a script repeats with the panel closed. */
  private readonly button_: HTMLButtonElement;
  private current_: ScriptRun | null = null;
  private readonly repeat_: HTMLSelectElement;
  private readonly log_: HTMLOListElement;
  private readonly logSummary_: HTMLElement;
  /** The script being run again and again (「繰り返し」), if one is. */
  private repeating_: Repeat | null = null;
  /** The question of a script that wants files (viewer.openFiles): only the person's click opens the picker. */
  private readonly ask_: HTMLElement;
  /** Answers the question being asked with no files (the run stopped, or another question came). */
  private declineAsk_: (() => void) | null = null;
  /** The suggestions of the editor. */
  readonly suggest: Suggest;

  constructor(
    button: HTMLButtonElement,
    private readonly context: Omit<ScriptContext, 'pickFiles'> & { say: (message: string) => void },
  ) {
    this.button_ = button;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service script-dialog';
    this.dialog.setAttribute('aria-labelledby', 'script-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="script-title">スクリプト</h2>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <div class="script-bar">
        <select name="choice" aria-label="スクリプトを開く"></select>
        <button type="button" value="save" title="この内容を名前を付けてブラウザに保存します">保存</button>
        <button type="button" value="delete" title="選んでいる保存済みのスクリプトを削除します">削除</button>
        <details class="script-more">
          <summary title="ファイル">…</summary>
          <div class="script-menu">
            <button type="button" value="open">.js を開く</button>
            <button type="button" value="download">.js に保存</button>
          </div>
        </details>
      </div>
      <div class="script-editor"><pre class="script-highlight" aria-hidden="true"></pre><textarea class="script-code" spellcheck="false" autocomplete="off" aria-label="スクリプト（JavaScript）"></textarea></div>
      <div class="script-ask" role="group" aria-label="スクリプトからの確認" hidden>
        <span></span>
        <button type="button" value="pick" class="primary">ファイルを選ぶ…</button>
        <button type="button" value="decline">やめる</button>
      </div>
      <div class="service-actions script-actions">
        <progress max="1" hidden></progress>
        <span class="script-status" role="status"></span>
        <select name="repeat" aria-label="繰り返し" title="繰り返し：選ぶと「実行」から、このページを開いている間その間隔で実行し続けます（「停止」まで）"></select>
        <button type="button" value="stop" disabled>停止</button>
        <button type="button" value="run" class="primary" title="実行（Ctrl+Enter）">実行</button>
      </div>
      <pre class="script-output" aria-label="出力" tabindex="0"></pre>
      <details class="script-log">
        <summary>実行の記録</summary>
        <ol aria-label="実行の記録"></ol>
        <p class="script-note">繰り返しはこのページを開いている間だけ動きます（ページやブラウザを閉じると止まります）。裏のタブでは、ブラウザが間隔を少し延ばすことがあります。</p>
      </details>
      <details class="script-reference">
        <summary>使える関数</summary>
        <p class="script-note">スクリプトはページから切り離された環境で動き、通信・保存領域・画面には触れません。ビューアの関数だけを <code>await</code> で呼べます。編集は編集バーの「保存」か <code>viewer.saveEdits()</code>（確認が出ます）まで、サーバーやファイルに書き込まれません。<code>viewer.</code> と打つと候補が出ます（Ctrl+Space でも）。座標は経緯度（WGS 84）です。</p>
        <dl></dl>
      </details>`;
    document.body.append(this.dialog);
    this.code_ = this.dialog.querySelector('textarea')!;
    this.highlight_ = this.dialog.querySelector('.script-highlight')!;
    this.choice_ = this.dialog.querySelector('select[name=choice]')!;
    this.output_ = this.dialog.querySelector('.script-output')!;
    this.status_ = this.dialog.querySelector('.script-status')!;
    this.progress_ = this.dialog.querySelector('progress')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.stop_ = this.dialog.querySelector('button[value=stop]')!;
    this.delete_ = this.dialog.querySelector('button[value=delete]')!;
    this.ask_ = this.dialog.querySelector('.script-ask')!;
    this.repeat_ = this.dialog.querySelector('select[name=repeat]')!;
    for (const [seconds, label] of REPEATS) this.repeat_.append(new Option(label, String(seconds)));
    this.log_ = this.dialog.querySelector('.script-log ol')!;
    this.logSummary_ = this.dialog.querySelector('.script-log summary')!;
    const list = this.dialog.querySelector('dl')!;
    for (const entry of ENTRIES) {
      const dt = document.createElement('dt');
      dt.textContent = `${entry.name}${entry.args}`;
      const dd = document.createElement('dd');
      dd.textContent = entry.doc;
      list.append(dt, dd);
    }

    this.code_.value = (() => {
      try {
        return localStorage.getItem(DRAFT_KEY) ?? SAMPLES[0].code;
      } catch {
        return SAMPLES[0].code;
      }
    })();
    this.paint_();
    this.listChoices();
    this.suggest = new Suggest(this.code_, (fn) => this.choices(fn));

    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    window.addEventListener('resize', () => this.dialog.open && this.place_());
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    // Esc in the editor leaves it (so Tab moves on again); elsewhere it closes the panel.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (e.target === this.code_) this.run_.focus();
      else this.close();
    });
    this.choice_.addEventListener('change', () => this.choose());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.delete_.addEventListener('click', () => this.remove());
    this.dialog.querySelector('button[value=open]')!.addEventListener('click', () => void this.openFile());
    this.dialog.querySelector('button[value=download]')!.addEventListener('click', () => {
      const name = this.choice_.value.startsWith('saved:') ? this.choice_.selectedOptions[0].text : 'script';
      download(`${name.replace(/[\\/:*?"<>|]/g, '_')}.js`, this.code_.value, 'text/javascript');
    });
    this.run_.addEventListener('click', () => this.run());
    this.stop_.addEventListener('click', () => this.stop());
    this.code_.addEventListener('scroll', () => this.scroll_());
    this.code_.addEventListener('input', () => {
      this.paint_();
      try {
        localStorage.setItem(DRAFT_KEY, this.code_.value);
      } catch {
        // Storage blocked: the draft lasts for this page only.
      }
    });
    this.code_.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.run();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        // Indents instead of leaving the editor (Esc leaves it).
        e.preventDefault();
        this.code_.setRangeText('  ', this.code_.selectionStart, this.code_.selectionEnd, 'end');
        this.code_.dispatchEvent(new Event('input'));
      }
    });
  }

  /** What goes in the quotes of `viewer.fn('…`: the tools, menus, base maps or themes it takes, else the layers. */
  private choices(fn: string): Choice[] {
    const c = this.context;
    if (fn === 'tool' || fn === 'toolOptions') return c.tools().map((t) => ({ name: t.id, detail: t.label }));
    if (fn === 'command') return c.commands().map((t) => ({ name: t.id, detail: t.label }));
    if (fn === 'setBaseMap') return c.baseMaps().map((b) => ({ name: b.id, detail: b.label }));
    if (fn === 'theme') return [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([name, detail]) => ({ name, detail }));
    if (fn === 'goBookmark') return c.bookmarks().get().map((b) => ({ name: b.name, detail: 'ブックマーク' }));
    if (fn === 'open' || fn === 'serviceLayers' || fn === 'saveText' || fn === 'addBookmark') return [];
    return c.layers().map((l) => ({ name: l.name, detail: 'レイヤー' }));
  }

  /** Shows the panel (non-modal, so layers can be selected and edits saved while it is open). */
  open(): void {
    if (!this.dialog.open) this.dialog.show();
    this.place_();
    this.code_.focus();
  }

  /** Colours the script under the editor's text. */
  private paint_(): void {
    // A trailing newline needs a character after it to take up its line, as it does in the textarea.
    this.highlight_.innerHTML = `${highlight(this.code_.value)} `;
    this.scroll_();
  }

  private scroll_(): void {
    this.highlight_.scrollTop = this.code_.scrollTop;
    this.highlight_.scrollLeft = this.code_.scrollLeft;
  }

  /** Below the top of the map with room for the edit toolbar, so its 「保存」 stays in reach (unless the user moved it). */
  private place_(): void {
    if ('moved' in this.dialog.dataset) return;
    const top = document.getElementById('map')?.getBoundingClientRect().top;
    if (top !== undefined) this.dialog.style.top = `${Math.round(top + 52)}px`;
  }

  close(): void {
    this.dialog.close();
  }

  /** Whether a script is running. */
  running(): boolean {
    return !!this.current_?.running();
  }

  /** The script in the editor. */
  code(): string {
    return this.code_.value;
  }

  setCode(code: string): void {
    this.code_.value = code;
    this.code_.dispatchEvent(new Event('input'));
  }

  /** What the last run printed. */
  output(): string {
    return this.output_.textContent ?? '';
  }

  /**
   * The script functions for a caller other than a script (the embedding API,
   * embed.ts), with the context adapted by `adapt`; no files are picked.
   */
  handlers(adapt: (ctx: ScriptContext) => ScriptContext = (ctx) => ctx): ScriptHandlers {
    return scriptHandlers(adapt({ ...this.context, pickFiles: async () => [] })).handlers;
  }

  /**
   * Runs the script in the editor (stopping one still running, and any
   * repeat). With 「繰り返し」 set, the script as it is now runs again at that
   * interval until 「停止」.
   */
  run(): ScriptRun {
    this.endRepeat_();
    const seconds = Number(this.repeat_.value);
    if (seconds > 0) {
      const name = this.choice_.value.startsWith('saved:') ? this.choice_.selectedOptions[0].text : '';
      this.repeating_ = { code: this.code_.value, name, seconds, timer: 0, next: null, runs: 0 };
      this.dialog.classList.add('repeating');
      this.button_.classList.add('script-repeating');
    }
    return this.runCode_(this.code_.value);
  }

  /** Whether a script is being run again and again (「繰り返し」). */
  repeating(): boolean {
    return !!this.repeating_;
  }

  /** Stops running the script again; a run going on is left to end. */
  private endRepeat_(): void {
    if (!this.repeating_) return;
    clearTimeout(this.repeating_.timer);
    this.repeating_ = null;
    this.dialog.classList.remove('repeating');
    this.button_.classList.remove('script-repeating');
  }

  /** After a run of a repeating script: the next one, an interval after the last one started (or now, if that has passed). */
  private scheduleNext_(started: number): void {
    const repeat = this.repeating_;
    if (!repeat) return;
    const wait = Math.max(0, started + repeat.seconds * 1000 - Date.now());
    repeat.next = new Date(Date.now() + wait);
    repeat.timer = window.setTimeout(() => {
      if (this.repeating_ !== repeat) return;
      repeat.next = null;
      this.runCode_(repeat.code);
    }, wait);
  }

  private runCode_(code: string): ScriptRun {
    this.current_?.stop();
    this.output_.textContent = '';
    this.setRunning(true);
    this.status_.textContent = '実行しています…';
    const started = performance.now();
    const startedAt = new Date();
    const repeat = this.repeating_;
    if (repeat) repeat.runs++;
    const { handlers, finish } = scriptHandlers({ ...this.context, pickFiles: (message, accept, multiple) => this.pickFiles(message, accept, multiple) });
    const run = new ScriptRun(code, handlers, {
      onLog: (text, level) => this.print(text, level),
      onProgress: (fraction, message) => {
        if (run !== this.current_) return;
        this.progress_.hidden = fraction === null;
        if (fraction !== null) this.progress_.value = fraction;
        this.status_.textContent = message || '実行しています…';
      },
      onEnd: (error, value) => {
        finish();
        if (run === this.current_) this.declineAsk_?.();
        if (run !== this.current_) return;
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (value !== undefined) this.print(value, 'log');
        if (error) this.print(`エラー: ${error}`, 'error');
        const pending = this.context.editor.session()?.count() ?? 0;
        const edits = pending ? `。未保存の変更が ${pending} 件あります（${this.context.editor.editing()?.name}）。確かめて編集バーの「保存」を押してください` : '';
        const result = error ? (error === '停止しました' ? '停止しました' : 'エラーで止まりました') : '完了';
        this.addLog_(startedAt, `${result}（${seconds} 秒）${error && error !== '停止しました' ? `: ${error}` : ''}`, !!error, repeat?.name ?? '');
        // A repeat goes on after an error too (the next run may well work); 「停止」 ends it.
        if (repeat && repeat === this.repeating_ && error !== '停止しました') this.scheduleNext_(startedAt.getTime());
        this.setRunning(false);
        const next = this.repeating_?.next;
        this.status_.textContent = `${result}（${seconds} 秒）${edits}${next ? `。次は ${clock(next)}（${REPEATS.find(([s]) => s === this.repeating_!.seconds)?.[1]}）` : ''}`;
        // Every run of a repeat would crowd the status line: only the first, and errors.
        if (!repeat || error || repeat.runs === 1) this.context.say(`スクリプト: ${this.status_.textContent}`);
      },
    });
    this.current_ = run;
    return run;
  }

  /** Stops the run going on and any repeat. */
  stop(): void {
    const waiting = this.repeating_ && !this.running();
    this.endRepeat_();
    this.declineAsk_?.();
    this.current_?.stop();
    if (waiting) {
      this.setRunning(false);
      this.status_.textContent = '繰り返しを止めました';
      this.context.say('スクリプト: 繰り返しを止めました');
    }
  }

  private setRunning(on: boolean): void {
    this.run_.disabled = on;
    this.stop_.disabled = !on && !this.repeating_;
    this.progress_.hidden = true;
    this.dialog.classList.toggle('running', on);
  }

  /** A line of 「実行の記録」, newest first. */
  private addLog_(time: Date, text: string, error: boolean, name: string): void {
    const item = document.createElement('li');
    item.className = error ? 'script-error' : '';
    const at = document.createElement('time');
    at.dateTime = time.toISOString();
    at.textContent = `${time.toLocaleDateString('ja-JP')} ${clock(time)}`;
    item.append(at, ` ${name ? `「${name}」 ` : ''}${text}`);
    this.log_.prepend(item);
    while (this.log_.children.length > LOG_SIZE) this.log_.lastElementChild!.remove();
    const errors = this.log_.querySelectorAll('.script-error').length;
    this.logSummary_.textContent = `実行の記録（${this.log_.children.length} 回${errors ? `、うちエラー ${errors}` : ''}）`;
  }

  /** The text of 「実行の記録」, newest first. */
  log(): string[] {
    return [...this.log_.children].map((li) => li.textContent ?? '');
  }

  /** The scripts saved in this browser (kept in project files). */
  savedScripts(): SavedScript[] {
    return readSaved();
  }

  /** Adds scripts (of a project file) to the saved ones; none is run. */
  addSaved(scripts: SavedScript[]): void {
    const list = readSaved();
    const merged = mergeScripts(list, scripts);
    if (merged.length === list.length || !writeSaved(merged)) return;
    this.listChoices(this.choice_.value);
  }

  private print(text: string, level: 'log' | 'warn' | 'error'): void {
    const line = document.createElement('div');
    line.className = level === 'log' ? '' : `script-${level}`;
    line.textContent = text;
    this.output_.append(line);
    this.output_.scrollTop = this.output_.scrollHeight;
  }

  private listChoices(selected = ''): void {
    this.choice_.replaceChildren(new Option('サンプル・保存したスクリプトを開く…', ''));
    const samples = document.createElement('optgroup');
    samples.label = 'サンプル';
    SAMPLES.forEach((s, i) => samples.append(new Option(s.name, `sample:${i}`)));
    this.choice_.append(samples);
    const saved = readSaved();
    if (saved.length) {
      const group = document.createElement('optgroup');
      group.label = '保存したスクリプト';
      saved.forEach((s, i) => group.append(new Option(s.name, `saved:${i}`)));
      this.choice_.append(group);
    }
    this.choice_.value = selected;
    this.delete_.disabled = !selected.startsWith('saved:');
  }

  private choose(): void {
    const [kind, index] = this.choice_.value.split(':');
    const script = kind === 'sample' ? SAMPLES[Number(index)] : kind === 'saved' ? readSaved()[Number(index)] : null;
    this.delete_.disabled = kind !== 'saved';
    if (!script) return;
    this.setCode(script.code);
    this.status_.textContent = `「${script.name}」を開きました。「実行」で動かします`;
  }

  private save(): void {
    const current = this.choice_.value.startsWith('saved:') ? this.choice_.selectedOptions[0].text : '';
    const name = prompt('スクリプトの名前', current)?.trim();
    if (!name) return;
    const list = readSaved();
    const at = list.findIndex((s) => s.name === name);
    if (at >= 0) list[at] = { name, code: this.code_.value };
    else list.push({ name, code: this.code_.value });
    if (!writeSaved(list)) return void (this.status_.textContent = 'ブラウザに保存できませんでした（「.js に保存」でファイルにできます）');
    this.listChoices(`saved:${at >= 0 ? at : list.length - 1}`);
    this.status_.textContent = `「${name}」をこのブラウザに保存しました`;
  }

  private remove(): void {
    const [kind, index] = this.choice_.value.split(':');
    if (kind !== 'saved') return;
    const list = readSaved();
    const script = list[Number(index)];
    if (!script || !confirm(`「${script.name}」を削除しますか？`)) return;
    list.splice(Number(index), 1);
    writeSaved(list);
    this.listChoices();
    this.status_.textContent = `「${script.name}」を削除しました`;
  }

  /**
   * Asks the person for files for the running script: a line in the panel
   * with a button, since a file picker opens only on the person's own click.
   * Resolves with no files when they decline or the run ends.
   */
  pickFiles(message: string, accept: string, multiple: boolean): Promise<File[]> {
    this.declineAsk_?.();
    if (!this.dialog.open) this.open();
    this.ask_.querySelector('span')!.textContent = message;
    this.ask_.hidden = false;
    const pick = this.ask_.querySelector<HTMLButtonElement>('button[value=pick]')!;
    const decline = this.ask_.querySelector<HTMLButtonElement>('button[value=decline]')!;
    pick.focus();
    return new Promise((resolve) => {
      const done = (files: File[]) => {
        this.ask_.hidden = true;
        pick.onclick = decline.onclick = null;
        this.declineAsk_ = null;
        resolve(files);
      };
      this.declineAsk_ = () => done([]);
      decline.onclick = () => done([]);
      pick.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
        input.addEventListener('cancel', () => done([]), { once: true });
        input.click();
      };
    });
  }

  /** Opens a .js file into the editor (shown, not run). */
  private async openFile(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.mjs,.txt,text/javascript,text/plain';
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return void (this.status_.textContent = 'ファイルが大きすぎます（2 MB まで）');
    this.setCode(await file.text());
    this.choice_.value = '';
    this.status_.textContent = `${file.name} を開きました。内容を確かめてから「実行」を押してください`;
  }
}
