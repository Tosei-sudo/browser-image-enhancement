/**
 * 「スクリプト」 (ツール): analysis and editing written in JavaScript, like
 * arcpy in ArcGIS. A sample to start from, the editor, 「実行」 and
 * 「停止」, and what the script prints. Scripts run apart from the page
 * (script/sandbox.ts) and reach the viewer only through `viewer.*` and
 * `geo.*` (script/api.ts); what they edit waits for 「保存」 on the edit
 * toolbar like any other edit.
 *
 * A script only runs when 「実行」 is pressed here: nothing runs by itself
 * from a project file, a link or the browser's storage. Scripts are kept in
 * this browser (localStorage) and can be opened from and saved to .js files.
 */
import { ScriptRun, type ScriptHandlers } from './script/sandbox.js';
import { scriptHandlers, type ScriptContext } from './script/api.js';
import { SAMPLES } from './script/samples.js';
import { download } from './local-edit.js';
import { highlight } from './script/highlight.js';
import { ENTRIES, Suggest, type Choice } from './script/suggest.js';

const SAVED_KEY = 'image-viewer.scripts';
const DRAFT_KEY = 'image-viewer.script-draft';

interface SavedScript {
  name: string;
  code: string;
}

function readSaved(): SavedScript[] {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((s): s is SavedScript => typeof s?.name === 'string' && typeof s?.code === 'string') : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedScript[]): boolean {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
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
  private current_: ScriptRun | null = null;
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
        <button type="button" value="stop" disabled>停止</button>
        <button type="button" value="run" class="primary" title="実行（Ctrl+Enter）">実行</button>
      </div>
      <pre class="script-output" aria-label="出力" tabindex="0"></pre>
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

  /** Runs the script in the editor (stopping one still running). */
  run(): ScriptRun {
    this.current_?.stop();
    this.output_.textContent = '';
    this.setRunning(true);
    this.status_.textContent = '実行しています…';
    const started = performance.now();
    const { handlers, finish } = scriptHandlers({ ...this.context, pickFiles: (message, accept, multiple) => this.pickFiles(message, accept, multiple) });
    const run = new ScriptRun(this.code_.value, handlers, {
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
        this.setRunning(false);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (value !== undefined) this.print(value, 'log');
        if (error) this.print(`エラー: ${error}`, 'error');
        const pending = this.context.editor.session()?.count() ?? 0;
        const edits = pending ? `。未保存の変更が ${pending} 件あります（${this.context.editor.editing()?.name}）。確かめて編集バーの「保存」を押してください` : '';
        this.status_.textContent = `${error ? (error === '停止しました' ? '停止しました' : 'エラーで止まりました') : '完了'}（${seconds} 秒）${edits}`;
        this.context.say(`スクリプト: ${this.status_.textContent}`);
      },
    });
    this.current_ = run;
    return run;
  }

  stop(): void {
    this.declineAsk_?.();
    this.current_?.stop();
  }

  private setRunning(on: boolean): void {
    this.run_.disabled = on;
    this.stop_.disabled = !on;
    this.progress_.hidden = true;
    this.dialog.classList.toggle('running', on);
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
